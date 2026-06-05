import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { InfobipSmsConnector } from './infobip.connector';
import type { InfobipConfig } from './infobip.config';
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

const defaultConfig: InfobipConfig = {
  apiKey: 'infobip-api-key-123',
  baseUrl: 'abc123.api.infobip.com',
  from: 'InfoSMS',
};

function successResponse() {
  return new Response(
    JSON.stringify({
      bulkId: 'bulk-123',
      messages: [
        {
          to: '+15559876543',
          status: {
            groupId: 1,
            groupName: 'PENDING',
            id: 26,
            name: 'PENDING_ACCEPTED',
            description: 'Message sent to next instance',
          },
          messageId: 'infobip-msg-123',
          smsCount: 1,
        },
      ],
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

describe('InfobipSmsConnector', () => {
  let connector: InfobipSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new InfobipSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path: POSTs JSON body with App auth to the per-account /sms/2/text/advanced URL', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '+15559876543',
        body: 'Hello from Infobip!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      // Per-account baseUrl asserted verbatim in URL.
      expect(url).toBe('https://abc123.api.infobip.com/sms/2/text/advanced');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'App infobip-api-key-123',
          Accept: 'application/json',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      // Single recipient wrapped in messages: [...] with destinations: [{ to }].
      expect(messages).toHaveLength(1);
      expect(messages[0]!.from).toBe('InfoSMS');
      expect(messages[0]!.destinations).toEqual([{ to: '+15559876543' }]);
      expect(messages[0]!.text).toBe('Hello from Infobip!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'infobip-msg-123',
        raw: expect.objectContaining({ bulkId: 'bulk-123' }),
      });
    });

    it('uses literal "App " prefix for custom auth scheme (not Bearer, not Basic)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({ to: '+15559876543', body: 'Hi' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('App infobip-api-key-123');
      expect(headers.Authorization).not.toMatch(/^Bearer /);
      expect(headers.Authorization).not.toMatch(/^Basic /);
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
      const messages = body.messages as Record<string, unknown>[];
      expect(messages[0]!.from).toBe('+15550000000');
    });

    it('throws invalid_request when neither input.from nor config.from is set', async () => {
      const noFromConnector = new InfobipSmsConnector({
        apiKey: 'infobip-api-key-123',
        baseUrl: 'abc123.api.infobip.com',
      });

      try {
        await noFromConnector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(400);
        expect(e.providerMessage).toContain('Infobip requires `from`');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('serializes Infobip narrowed fields with camelCase wire keys', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Compliance OTP',
        bulkId: 'bulk-abc',
        callbackData: 'cb-data',
        notifyUrl: 'https://example.com/dlr',
        notifyContentType: 'application/json',
        validityPeriod: 2,
        validityPeriodTimeUnit: 'MINUTES',
        flash: true,
        language: { languageCode: 'TR' },
        transliteration: 'TURKISH',
        scheduleSettings: { sendAt: '2026-06-01T00:00:00Z' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      // Top-level wire keys.
      expect(body.bulkId).toBe('bulk-abc');
      expect(body.sendingDateTime).toBe('2026-06-01T00:00:00Z');
      // Per-message wire keys.
      const messages = body.messages as Record<string, unknown>[];
      expect(messages[0]!.callbackData).toBe('cb-data');
      expect(messages[0]!.notifyUrl).toBe('https://example.com/dlr');
      expect(messages[0]!.notifyContentType).toBe('application/json');
      expect(messages[0]!.validityPeriod).toBe(2);
      expect(messages[0]!.validityPeriodTimeUnit).toBe('MINUTES');
      expect(messages[0]!.flash).toBe(true);
      expect(messages[0]!.language).toEqual({ languageCode: 'TR' });
      expect(messages[0]!.transliteration).toBe('TURKISH');
    });

    it('maps HTTP 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, {
          requestError: {
            serviceException: {
              messageId: 'UNAUTHORIZED',
              text: 'Invalid API key',
            },
          },
        }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('Invalid API key');
      }
    });

    it('maps HTTP 429 with Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: {
            requestError: {
              serviceException: {
                messageId: 'TOO_MANY_REQUESTS',
                text: 'Too Many Requests',
              },
            },
          },
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
        errorResponse(500, {
          requestError: {
            serviceException: {
              messageId: 'GENERAL_ERROR',
              text: 'Internal error',
            },
          },
        }),
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
        errorResponse(400, {
          requestError: {
            serviceException: {
              messageId: 'EC_INVALID_DESTINATION_ADDRESS',
              text: 'Invalid destination',
            },
          },
        }),
      );

      try {
        await connector.send({ to: '+1invalid', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_request');
        // EC_* code preserved in cause.raw.
        expect((e.cause as Record<string, unknown>).raw).toMatchObject({
          requestError: {
            serviceException: {
              messageId: 'EC_INVALID_DESTINATION_ADDRESS',
            },
          },
        });
      }
    });

    it('merges _passthrough.body, _passthrough.headers, and _passthrough.query into the request', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hi',
        _passthrough: {
          body: { customField: 'x' },
          headers: { 'X-Trace-Id': 't-1' },
          query: { dryRun: 'true' },
        },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://abc123.api.infobip.com/sms/2/text/advanced?dryRun=true',
      );
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.customField).toBe('x');
      expect(body.messages).toBeDefined();
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
    it('should have id "infobip" and channelType SMS', () => {
      expect(connector.id).toBe('infobip');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('should send a JSON message with App auth to the correct URL', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello from Infobip!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://abc123.api.infobip.com/sms/3/messages');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'App infobip-api-key-123',
        })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      expect(messages[0]!.from).toBe('InfoSMS');
      expect(messages[0]!.destinations).toEqual([{ to: '+15559876543' }]);
      expect(messages[0]!.text).toBe('Hello from Infobip!');

      expect(result).toEqual({ id: 'infobip-msg-123', date: expect.any(String) });
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
      const messages = body.messages as Record<string, unknown>[];
      expect(messages[0]!.from).toBe('+15550000000');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { to: '+15559876543', content: 'Hello!' },
        {
          _passthrough: { body: { sendAt: '2024-06-01T00:00:00Z' } },
        }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.sendAt).toBe('2024-06-01T00:00:00Z');
      expect(body.messages).toBeDefined();
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requestError: {
              serviceException: { messageId: 'UNAUTHORIZED', text: 'Invalid API key' },
            },
          }),
          { status: 401 }
        )
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
        expect(connectorErr.providerMessage).toBe('Invalid API key');
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
