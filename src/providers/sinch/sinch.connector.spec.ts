import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { SinchSmsConnector } from './sinch.connector';
import type { SinchConfig } from './sinch.config';
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

const defaultConfig: SinchConfig = {
  servicePlanId: 'plan-123',
  apiToken: 'sinch-token',
  from: '+15551234567',
};

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 'sinch-batch-123',
      to: ['+15559876543'],
      from: '+15551234567',
      body: 'Hello',
      type: 'mt_text',
      created_at: '2024-01-01T00:00:00Z',
      modified_at: '2024-01-01T00:00:00Z',
      ...overrides,
    }),
    { status: 200 },
  );
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('SinchSmsConnector', () => {
  let connector: SinchSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new SinchSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path: POSTs JSON body with Bearer auth to the US regional URL and wraps `to` in an array', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '+15559876543',
        body: 'Hello from Sinch!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://us.sms.api.sinch.com/xms/v1/plan-123/batches');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer sinch-token',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.from).toBe('+15551234567');
      expect(body.to).toEqual(['+15559876543']);
      expect(body.body).toBe('Hello from Sinch!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'sinch-batch-123',
        raw: expect.objectContaining({ id: 'sinch-batch-123' }),
      });
    });

    it('region: "eu" routes to https://eu.sms.api.sinch.com', async () => {
      const euConnector = new SinchSmsConnector({
        ...defaultConfig,
        region: 'eu',
      });
      mockFetch.mockResolvedValueOnce(successResponse());

      await euConnector.send({ to: '+15559876543', body: 'Hi' });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://eu.sms.api.sinch.com/xms/v1/plan-123/batches');
    });

    it('uses per-call from when provided, overriding config.from', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: '+15550000000',
        to: '+15559876543',
        body: 'Hi',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.from).toBe('+15550000000');
    });

    it('throws invalid_request when neither input.from nor config.from is set', async () => {
      const noFromConnector = new SinchSmsConnector({
        servicePlanId: 'plan-123',
        apiToken: 'sinch-token',
      });

      try {
        await noFromConnector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(400);
        expect(e.providerMessage).toContain('Sinch requires `from`');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('serializes narrowed Sinch fields with snake_case wire keys', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'flash',
        type: 'mt_text',
        deliveryReport: 'full',
        sendAt: '2026-06-01T00:00:00Z',
        expireAt: '2026-06-01T01:00:00Z',
        callbackUrl: 'https://example.com/cb',
        clientReference: 'ref-1',
        feedbackEnabled: true,
        flashMessage: true,
        parameters: { name: { '+15559876543': 'Alice' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.type).toBe('mt_text');
      expect(body.delivery_report).toBe('full');
      expect(body.send_at).toBe('2026-06-01T00:00:00Z');
      expect(body.expire_at).toBe('2026-06-01T01:00:00Z');
      expect(body.callback_url).toBe('https://example.com/cb');
      expect(body.client_reference).toBe('ref-1');
      expect(body.feedback_enabled).toBe(true);
      expect(body.flash_message).toBe(true);
      expect(body.parameters).toEqual({ name: { '+15559876543': 'Alice' } });
    });

    it('maps HTTP 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, { code: 'unauthorized', text: 'Invalid credentials' }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('Invalid credentials');
      }
    });

    it('maps HTTP 429 with Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { code: 'rate_limited', text: 'Too Many Requests' },
        }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(429);
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('Too Many Requests');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('maps body.code "invalid_recipient" on a 400 → invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          code: 'invalid_recipient',
          text: 'Invalid destination number',
        }),
      );

      try {
        await connector.send({ to: '+1invalid', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toBe('Invalid destination number');
      }
    });

    it('maps HTTP 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, { text: 'Internal Server Error' }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });

    it('maps default 4xx (without a recognized body code) → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, { code: 'something_else', text: 'Bad request' }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('merges _passthrough.body, _passthrough.headers, and _passthrough.query into the request', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hi',
        _passthrough: {
          body: { custom_field: 'x' },
          headers: { 'X-Trace-Id': 't-1' },
          query: { dry_run: 'true' },
        },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://us.sms.api.sinch.com/xms/v1/plan-123/batches?dry_run=true',
      );
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.custom_field).toBe('x');
      expect(body.to).toEqual(['+15559876543']);
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Trace-Id': 't-1' }),
      );
    });

    it('flashMessage + sendAt scheduling fields are written as snake_case JSON', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Scheduled flash',
        flashMessage: true,
        sendAt: '2026-06-01T00:00:00Z',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.flash_message).toBe(true);
      expect(body.send_at).toBe('2026-06-01T00:00:00Z');
      // sanity: no camelCase leakage
      expect(body.flashMessage).toBeUndefined();
      expect(body.sendAt).toBeUndefined();
    });

    it('wraps fetch network errors as ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await connector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.statusCode).toBeNull();
      }
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('should have id "sinch" and channelType SMS', () => {
      expect(connector.id).toBe('sinch');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('should send a JSON message with Bearer auth to the correct regional URL', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello from Sinch!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://us.sms.api.sinch.com/xms/v1/plan-123/batches');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer sinch-token',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.from).toBe('+15551234567');
      expect(body.to).toEqual(['+15559876543']);
      expect(body.body).toBe('Hello from Sinch!');

      expect(result).toEqual({ id: 'sinch-batch-123', date: expect.any(String) });
    });

    it('should use configured region in URL', async () => {
      const euConnector = new SinchSmsConnector({ ...defaultConfig, region: 'eu' });
      mockFetch.mockResolvedValueOnce(successResponse());

      await euConnector.sendMessage({ to: '+15559876543', content: 'Hello' });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://eu.sms.api.sinch.com/xms/v1/plan-123/batches');
    });

    it('should use options.from over config.from', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello',
        from: '+15550000000',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.from).toBe('+15550000000');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'unauthorized', text: 'Invalid credentials' }),
          { status: 401 },
        ),
      );

      try {
        await connector.sendMessage({ to: '+15559876543', content: 'Hello' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(401);
        // Brownfield now routes through canonical mapping
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Invalid credentials');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({ to: '+15559876543', content: 'Hello' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network failure');
      }
    });
  });
});
