import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { D7NetworksSmsConnector } from './d7networks.connector';
import type { D7NetworksConfig } from './d7networks.config';
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

const defaultConfig: D7NetworksConfig = {
  apiToken: 'd7-bearer-token-123',
  from: 'D7SMS',
};

function successResponse() {
  return new Response(
    JSON.stringify({
      request_id: 'd7-req-abc-123',
      status: 'accepted',
      created_at: '2024-01-01T00:00:00Z',
    }),
    { status: 200 }
  );
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('D7NetworksSmsConnector', () => {
  let connector: D7NetworksSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new D7NetworksSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path: POSTs nested messages[] + message_globals body with Bearer auth and returns SmsSendResult', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '+15559876543',
        body: 'Hello from D7!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.d7networks.com/messages/v1/send');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer d7-bearer-token-123',
          Accept: 'application/json',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      expect(messages).toHaveLength(1);
      expect(messages[0]!.channel).toBe('sms');
      expect(messages[0]!.recipients).toEqual(['+15559876543']);
      expect(messages[0]!.content).toBe('Hello from D7!');
      expect(messages[0]!.msg_type).toBe('text');

      const messageGlobals = body.message_globals as Record<string, unknown>;
      expect(messageGlobals.originator).toBe('D7SMS');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'd7-req-abc-123',
        raw: expect.objectContaining({ request_id: 'd7-req-abc-123' }),
      });
    });

    it('serializes dataCoding as wire key `data_coding` on the per-message entry (NOT `dataCoding`)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'unicode',
        dataCoding: 'unicode',
        msgType: 'flash',
        tag: 'campaign-1',
        scheduleTime: '+5 minutes',
        validityPeriod: 60,
        reportUrl: 'https://example.com/dlr',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      const messages = body.messages as Record<string, unknown>[];
      const messageGlobals = body.message_globals as Record<string, unknown>;

      // Per-message wire keys
      expect(messages[0]!.data_coding).toBe('unicode');
      expect(messages[0]!.dataCoding).toBeUndefined();
      expect(messages[0]!.msg_type).toBe('flash');

      // message_globals wire keys
      expect(messageGlobals.tag).toBe('campaign-1');
      expect(messageGlobals.schedule_time).toBe('+5 minutes');
      expect(messageGlobals.validity_period).toBe(60);
      expect(messageGlobals.report_url).toBe('https://example.com/dlr');

      // sanity: no camelCase leakage at the globals level either
      expect(messageGlobals.scheduleTime).toBeUndefined();
      expect(messageGlobals.validityPeriod).toBeUndefined();
      expect(messageGlobals.reportUrl).toBeUndefined();
    });

    it('originator precedence: input.originator > input.from > config.from', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hi',
        from: '+15550000000',
        originator: 'BRAND',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      const messageGlobals = body.message_globals as Record<string, unknown>;
      expect(messageGlobals.originator).toBe('BRAND');
    });

    it('falls back to input.from when originator is absent', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hi',
        from: '+15550000000',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      const messageGlobals = body.message_globals as Record<string, unknown>;
      expect(messageGlobals.originator).toBe('+15550000000');
    });

    it('throws invalid_request when neither originator, from, nor config.from is set', async () => {
      const noFromConnector = new D7NetworksSmsConnector({
        apiToken: 'd7-bearer-token-123',
      });

      try {
        await noFromConnector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(400);
        expect(e.providerMessage).toContain('D7 Networks requires');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('maps HTTP 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, { code: 'UNAUTHORIZED', detail: 'Invalid token' }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('Invalid token');
      }
    });

    it('maps HTTP 429 with Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { code: 'RATE_LIMITED', detail: 'Too Many Requests' },
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

    it('maps HTTP 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, { code: 'INTERNAL', detail: 'Internal Server Error' }),
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

    it('maps default 4xx → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, { code: 'BAD_REQUEST', detail: 'Bad payload' }),
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

    it('merges _passthrough.body and _passthrough.headers into the request', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hi',
        _passthrough: {
          body: { custom_top_level: 'x' },
          headers: { 'X-Trace-Id': 't-1' },
        },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.d7networks.com/messages/v1/send');
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.custom_top_level).toBe('x');
      expect(body.messages).toBeDefined();
      expect(body.message_globals).toBeDefined();
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Trace-Id': 't-1' }),
      );
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
    it('should have id "d7networks" and channelType SMS', () => {
      expect(connector.id).toBe('d7networks');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('should send a JSON message with Bearer auth and return { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello from D7Networks!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.d7networks.com/messages/v1/send');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer d7-bearer-token-123',
        })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      expect(messages[0]!.channel).toBe('sms');
      expect(messages[0]!.recipients).toEqual(['+15559876543']);
      expect(messages[0]!.content).toBe('Hello from D7Networks!');
      expect(messages[0]!.msg_type).toBe('text');

      const messageGlobals = body.message_globals as Record<string, unknown>;
      expect(messageGlobals.originator).toBe('D7SMS');

      expect(result).toEqual({ id: 'd7-req-abc-123', date: expect.any(String) });
    });

    it('should use options.from over config.from', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello',
        from: '+15550000000',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      const messageGlobals = body.message_globals as Record<string, unknown>;
      expect(messageGlobals.originator).toBe('+15550000000');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { to: '+15559876543', content: 'Hello!' },
        { _passthrough: { body: { report_url: 'https://example.com/callback' } } }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.report_url).toBe('https://example.com/callback');
      expect(body.messages).toBeDefined();
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', detail: 'Invalid token' }), { status: 401 })
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
        expect(connectorErr.providerMessage).toBe('Invalid token');
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
