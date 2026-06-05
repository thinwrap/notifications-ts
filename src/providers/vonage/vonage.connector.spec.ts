import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { VonageSmsConnector } from './vonage.connector';
import type { VonageConfig } from './vonage.config';
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

const defaultConfig: VonageConfig = {
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  from: '15551234567',
};

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      'message-count': '1',
      messages: [
        {
          'message-id': '0A0000001234ABCD',
          status: '0',
          to: '447900000000',
          ...overrides,
        },
      ],
    }),
    { status: 200 },
  );
}

function softFailResponse(
  status: string,
  errorText: string,
): Response {
  return new Response(
    JSON.stringify({
      'message-count': '1',
      messages: [
        {
          status,
          'error-text': errorText,
          to: '447900000000',
        },
      ],
    }),
    { status: 200 },
  );
}

function errorResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

describe('VonageSmsConnector', () => {
  let connector: VonageSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new VonageSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    // -------------------------------------------------------------------------
    // 2xx happy path
    // -------------------------------------------------------------------------

    it('sends form-encoded body and returns canonical SmsSendResult on 2xx', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '447900000000',
        body: 'Hello from Vonage!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://rest.nexmo.com/sms/json');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      );

      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('api_key')).toBe('test-api-key');
      expect(params.get('api_secret')).toBe('test-api-secret');
      expect(params.get('from')).toBe('15551234567');
      expect(params.get('to')).toBe('447900000000');
      expect(params.get('text')).toBe('Hello from Vonage!');

      expect(result).toMatchObject({
        success: true,
        status: 'sent',
        providerMessageId: '0A0000001234ABCD',
      });
      expect(result.raw).toMatchObject({
        'message-count': '1',
        messages: [
          expect.objectContaining({
            'message-id': '0A0000001234ABCD',
            status: '0',
          }),
        ],
      });
    });

    it('uses per-call from when provided, overriding config.from', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: '18005550199',
        to: '447900000000',
        body: 'Hi',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('from')).toBe('18005550199');
    });

    it('throws invalid_request when neither input.from nor config.from is set', async () => {
      const noFromConnector = new VonageSmsConnector({
        apiKey: 'k',
        apiSecret: 's',
      });

      try {
        await noFromConnector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_request');
        expect(e.providerMessage).toContain('Vonage requires `from`');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('serializes narrowed Vonage fields with kebab-case wire keys', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '447900000000',
        body: 'flash',
        clientRef: 'ref-1',
        messageClass: 0,
        type: 'unicode',
        statusReportReq: 1,
        ttl: 60000,
        callback: 'https://example.com/dlr',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('client-ref')).toBe('ref-1');
      expect(params.get('message-class')).toBe('0');
      expect(params.get('type')).toBe('unicode');
      expect(params.get('status-report-req')).toBe('1');
      expect(params.get('ttl')).toBe('60000');
      expect(params.get('callback')).toBe('https://example.com/dlr');
    });

    // -------------------------------------------------------------------------
    // Soft-fail status (HTTP 200 status '1')
    // -------------------------------------------------------------------------

    it('maps HTTP 200 + status "1" (throttled) to rate_limited ConnectorError', async () => {
      mockFetch.mockResolvedValueOnce(softFailResponse('1', 'Throttled'));

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toContain('Throttled');
        // Soft rate-limit carries no Retry-After.
        expect(e.providerMessage).not.toContain('Retry-After:');
      }
    });

    it('maps HTTP 200 + status "4" (invalid credentials) to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        softFailResponse('4', 'Invalid credentials'),
      );

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('Invalid credentials');
      }
    });

    it('maps HTTP 200 + status "7" (number barred) to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        softFailResponse('7', 'Number barred'),
      );

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_recipient');
      }
    });

    it('maps unknown soft-fail status to "unknown"', async () => {
      mockFetch.mockResolvedValueOnce(softFailResponse('999', 'mystery'));

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('unknown');
      }
    });

    // -------------------------------------------------------------------------
    // Vendor 4xx → mapped providerCode
    // -------------------------------------------------------------------------

    it('maps HTTP 401 to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401, 'Unauthorized'));

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
      }
    });

    it('maps HTTP 429 to rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '30',
          errorBody: 'Too Many Requests',
          contentType: 'text/plain',
        }),
      );

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(429);
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('Too Many Requests');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '30',
          retryAfterSeconds: 30,
        });
      }
    });

    it('maps HTTP 500 to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal error'));

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });

    // -------------------------------------------------------------------------
    // `_passthrough` honored
    // -------------------------------------------------------------------------

    it('merges _passthrough.body into form-encoded wire body and _passthrough.headers into request headers', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '447900000000',
        body: 'Hi',
        _passthrough: {
          body: { 'callback-format': 'json' },
          headers: { 'X-Trace-Id': 't-1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('callback-format')).toBe('json');
      expect(params.get('api_key')).toBe('test-api-key');
      expect(params.get('to')).toBe('447900000000');
      expect(params.get('text')).toBe('Hi');

      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Trace-Id': 't-1' }),
      );
    });

    // -------------------------------------------------------------------------
    // `nexmo` alias smoke
    // -------------------------------------------------------------------------

    it('class id is the canonical "vonage" regardless of facade alias dispatch', () => {
      const c = new VonageSmsConnector(defaultConfig);
      expect(c.id).toBe('vonage');
      // The alias logic lives at the `Sms` facade — instantiation here is
      // direct, and the class field never reports `'nexmo'`.
    });

    // -------------------------------------------------------------------------
    // Network error
    // -------------------------------------------------------------------------

    it('throws provider_unavailable ConnectorError on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('boom'));

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.statusCode).toBeNull();
      }
    });

    // -------------------------------------------------------------------------
    // Malformed wire envelope
    // -------------------------------------------------------------------------

    it('throws "unknown" providerCode when response is missing messages[0]', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 'message-count': '0', messages: [] }), {
          status: 200,
        }),
      );

      try {
        await connector.send({ to: '447900000000', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('unknown');
        expect(e.providerMessage).toContain('messages[0]');
      }
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('reports the canonical id "vonage" and channelType SMS', () => {
      expect(connector.id).toBe('vonage');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('sends a message successfully with correct URL and form-encoded body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ 'message-id': 'abc123' }));

      const result = await connector.sendMessage({
        to: '14155550100',
        content: 'Hello from Vonage!',
        from: '15559999999',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://rest.nexmo.com/sms/json');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      );

      const params = new URLSearchParams(reqInit.body as string);
      // Vonage wire is snake_case (`api_key`, `api_secret`).
      expect(params.get('api_key')).toBe('test-api-key');
      expect(params.get('api_secret')).toBe('test-api-secret');
      expect(params.get('to')).toBe('14155550100');
      expect(params.get('from')).toBe('15559999999');
      expect(params.get('text')).toBe('Hello from Vonage!');

      expect(result).toEqual({ id: 'abc123', date: expect.any(String) });
      expect(() => new Date(result.date!)).not.toThrow();
    });

    it('uses default "from" from config when not provided in options', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        to: '14155550100',
        content: 'Hello!',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('from')).toBe('15551234567');
    });

    it('merges bridgeProviderData passthrough body into the request', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { to: '14155550100', content: 'Hello!' },
        {
          _passthrough: {
            body: {
              callback: 'https://example.com/callback',
              'client-ref': 'my-ref-123',
            },
          },
        },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('callback')).toBe('https://example.com/callback');
      expect(params.get('client-ref')).toBe('my-ref-123');
      expect(params.get('api_key')).toBe('test-api-key');
      expect(params.get('to')).toBe('14155550100');
      expect(params.get('text')).toBe('Hello!');
    });

    it('throws ConnectorError when Vonage returns a non-zero status', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({ status: '4', 'error-text': 'Invalid credentials' }),
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
        expect(connectorErr.message).toBe('Invalid credentials');
        // Brownfield now routes through canonical mapVonageStatus
        expect(connectorErr.statusCode).toBe(200);
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Invalid credentials');
      }
    });
  });
});
