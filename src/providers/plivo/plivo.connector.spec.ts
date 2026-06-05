import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { PlivoSmsConnector } from './plivo.connector';
import type { PlivoConfig } from './plivo.config';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../utils';
import { createRetryAfterFixture } from '../../test-utils';

const mockFetch = vi.fn();

beforeAll(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: PlivoConfig = {
  authId: 'PLIVO_AUTH_ID',
  authToken: 'plivo-auth-token',
  from: '14155551234',
};

function successResponse(
  overrides: Partial<{ message_uuid: string[]; status: number }> = {},
): Response {
  return new Response(
    JSON.stringify({
      api_id: 'api-id-123',
      message: 'message(s) queued',
      message_uuid: overrides.message_uuid ?? ['uuid-abc-123'],
    }),
    { status: overrides.status ?? 202 },
  );
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('PlivoSmsConnector', () => {
  let connector: PlivoSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new PlivoSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path: POSTs snake_case JSON body with Basic auth to Plivo Messages endpoint', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '14155550100',
        body: 'Hello from Plivo!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://api.plivo.com/v1/Account/PLIVO_AUTH_ID/Message/',
      );

      const expectedAuth = Buffer.from(
        'PLIVO_AUTH_ID:plivo-auth-token',
      ).toString('base64');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: `Basic ${expectedAuth}`,
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.src).toBe('14155551234');
      expect(body.dst).toBe('14155550100');
      expect(body.text).toBe('Hello from Plivo!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'uuid-abc-123',
        raw: expect.objectContaining({
          api_id: 'api-id-123',
          message_uuid: ['uuid-abc-123'],
        }),
      });
    });

    it('propagates DLT compliance fields as snake_case wire keys', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '917000000000',
        body: 'OTP: 123456',
        dltEntityId: '1001234567890123456',
        dltTemplateId: '1007654321098765432',
        dltTemplateCategory: 'transactional',
        templateId: 'tmpl_abc',
        powerpackUuid: 'pp-uuid-xyz',
        url: 'https://example.com/cb',
        method: 'POST',
        log: false,
        trackable: true,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.dlt_entity_id).toBe('1001234567890123456');
      expect(body.dlt_template_id).toBe('1007654321098765432');
      expect(body.dlt_template_category).toBe('transactional');
      expect(body.template_id).toBe('tmpl_abc');
      expect(body.powerpack_uuid).toBe('pp-uuid-xyz');
      expect(body.url).toBe('https://example.com/cb');
      expect(body.method).toBe('POST');
      expect(body.log).toBe(false);
      expect(body.trackable).toBe(true);
    });

    it('maps 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, {
          api_id: 'err-id',
          error: 'authentication failed',
        }),
      );

      try {
        await connector.send({ to: '14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('authentication failed');
      }
    });

    it('maps 429 with Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { api_id: 'err-id', error: 'rate limit exceeded' },
        }),
      );

      try {
        await connector.send({ to: '14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(429);
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('rate limit exceeded');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('_passthrough body + headers honored (custom JSON field merges; X-Idempotency-Key in headers)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '14155550100',
        body: 'Hello',
        _passthrough: {
          body: { custom_field: 'x' },
          headers: { 'X-Idempotency-Key': 'k1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.custom_field).toBe('x');
      expect(body.dst).toBe('14155550100');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Idempotency-Key': 'k1' }),
      );
    });

    it('throws invalid_request when neither from nor powerpackUuid is available', async () => {
      const noFromConnector = new PlivoSmsConnector({
        authId: 'PLIVO_AUTH_ID',
        authToken: 'plivo-auth-token',
      });

      try {
        await noFromConnector.send({ to: '14155550100', body: 'Hi' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(400);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('powerpackUuid is accepted as alternative to from (no src field on the wire)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const noFromConnector = new PlivoSmsConnector({
        authId: 'PLIVO_AUTH_ID',
        authToken: 'plivo-auth-token',
      });

      await noFromConnector.send({
        to: '14155550100',
        body: 'Hi',
        powerpackUuid: 'pp-uuid-xyz',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.src).toBeUndefined();
      expect(body.powerpack_uuid).toBe('pp-uuid-xyz');
    });

    it('maps 5xx → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, { api_id: 'err-id', error: 'internal error' }),
      );

      try {
        await connector.send({ to: '14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });

    it('maps 400 → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, { api_id: 'err-id', error: 'bad request' }),
      );

      try {
        await connector.send({ to: '14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_request');
        expect(e.providerMessage).toBe('bad request');
      }
    });

    it('wraps fetch network errors as ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await connector.send({ to: '14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.statusCode).toBeNull();
      }
    });

    it('uses BYO fetch from config when supplied', async () => {
      const byoFetch = vi.fn().mockResolvedValueOnce(successResponse());
      const byoConnector = new PlivoSmsConnector({
        ...defaultConfig,
        fetch: byoFetch as unknown as typeof fetch,
      });

      await byoConnector.send({ to: '14155550100', body: 'Hi' });

      expect(byoFetch).toHaveBeenCalledOnce();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('should have id "plivo" and channelType SMS', () => {
      expect(connector.id).toBe('plivo');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('should send JSON message with Basic auth to correct URL', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        to: '14155550100',
        content: 'Hello from Plivo!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.plivo.com/v1/Account/PLIVO_AUTH_ID/Message/');

      const expectedAuth = Buffer.from('PLIVO_AUTH_ID:plivo-auth-token').toString('base64');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: `Basic ${expectedAuth}`,
        })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.src).toBe('14155551234');
      expect(body.dst).toBe('14155550100');
      expect(body.text).toBe('Hello from Plivo!');

      expect(result).toEqual({ id: 'uuid-abc-123', date: expect.any(String) });
    });

    it('should use "from" in options when it overrides the config default', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        to: '14155550100',
        content: 'Hello!',
        from: '18005550199',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.src).toBe('18005550199');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { to: '14155550100', content: 'Hello!' },
        {
          _passthrough: { body: { url: 'https://example.com/callback' } },
        }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.url).toBe('https://example.com/callback');
      expect(body.dst).toBe('14155550100');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ api_id: 'err-id', error: 'Authentication Failed' }), { status: 401 })
      );

      try {
        await connector.sendMessage({
          to: '14155550100',
          content: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(401);
        // Brownfield now routes through canonical mapping
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Authentication Failed');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({
          to: '14155550100',
          content: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network failure');
      }
    });
  });
});
