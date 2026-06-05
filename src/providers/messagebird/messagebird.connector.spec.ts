import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MessageBirdSmsConnector } from './messagebird.connector';
import type { MessageBirdConfig } from './messagebird.config';
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

const defaultConfig: MessageBirdConfig = {
  accessKey: 'live_abc123',
  from: 'MyApp',
};

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 'mbird-msg-123',
      href: 'https://rest.messagebird.com/messages/mbird-msg-123',
      direction: 'mt',
      type: 'sms',
      originator: 'MyApp',
      body: 'Hello',
      gateway: 240,
      datacoding: 'plain',
      mclass: 1,
      createdDatetime: '2026-05-17T00:00:00Z',
      recipients: {
        totalCount: 1,
        totalSentCount: 1,
        totalDeliveredCount: 0,
        totalDeliveryFailedCount: 0,
        items: [{ recipient: 15559876543, status: 'sent' }],
      },
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

describe('MessageBirdSmsConnector', () => {
  let connector: MessageBirdSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new MessageBirdSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path: POSTs JSON body with AccessKey auth, wraps `recipients` in an array, and returns SmsSendResult', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '+15559876543',
        body: 'Hello from MessageBird!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://rest.messagebird.com/messages');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'AccessKey live_abc123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.originator).toBe('MyApp');
      expect(body.recipients).toEqual(['+15559876543']);
      expect(body.body).toBe('Hello from MessageBird!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'mbird-msg-123',
        raw: expect.objectContaining({ id: 'mbird-msg-123' }),
      });
    });

    it('uses the custom `AccessKey <accessKey>` auth scheme (not Bearer, not Basic)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({ to: '+15559876543', body: 'Hi' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('AccessKey live_abc123');
      expect(headers.Authorization!.startsWith('Bearer ')).toBe(false);
      expect(headers.Authorization!.startsWith('Basic ')).toBe(false);
    });

    it('translates `dataCoding` (TS narrowed) → `datacoding` (lowercased-flat wire key) and writes `mclass` lowercased-flat', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Unicode greeting',
        dataCoding: 'unicode',
        mclass: 1,
        scheduledDatetime: '2026-06-01T00:00:00Z',
        typeDetails: { udh: 'abcd' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      // Wire shape: lowercased-flat outlier mapping.
      expect(body.datacoding).toBe('unicode');
      expect(body.mclass).toBe(1);
      // No camelCase leakage of the outliers.
      expect(body.dataCoding).toBeUndefined();
      // Other camelCase narrowed keys preserved verbatim (explicit).
      expect(body.scheduledDatetime).toBe('2026-06-01T00:00:00Z');
      expect(body.typeDetails).toEqual({ udh: 'abcd' });
    });

    it('maps HTTP 401 → auth_failed and HTTP 429 with Retry-After: 60 → rate_limited with parsed seconds in providerMessage and raw header on cause.retryAfter', async () => {
      // 401 first
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, {
          errors: [{ code: 2, description: 'Request not allowed (incorrect access_key)' }],
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
        expect(e.providerMessage).toBe(
          'Request not allowed (incorrect access_key)',
        );
      }

      // 429 with Retry-After
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: {
            errors: [{ code: 9, description: 'Rate limit exceeded' }],
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
        expect(e.providerMessage).toBe('Rate limit exceeded');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('merges _passthrough.body, _passthrough.headers, and _passthrough.query into the request', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hi',
        _passthrough: {
          body: { reportUrl: 'https://example.com/dlr' },
          headers: { 'X-Trace-Id': 't-1' },
          query: { dry_run: 'true' },
        },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://rest.messagebird.com/messages?dry_run=true');
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.reportUrl).toBe('https://example.com/dlr');
      expect(body.recipients).toEqual(['+15559876543']);
      expect(body.originator).toBe('MyApp');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'X-Trace-Id': 't-1',
          Authorization: 'AccessKey live_abc123',
        }),
      );
    });

    // -------------------------------------------------------------------------
    // Coverage extras (kept under the .send() block for cohesion)
    // -------------------------------------------------------------------------

    it('throws invalid_request when neither input.from nor config.from is set', async () => {
      const noFromConnector = new MessageBirdSmsConnector({
        accessKey: 'live_abc123',
      });

      try {
        await noFromConnector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(400);
        expect(e.providerMessage).toContain('MessageBird requires `from`');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('uses per-call from when provided, overriding config.from', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'PerCallSender',
        to: '+15559876543',
        body: 'Hi',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.originator).toBe('PerCallSender');
    });

    it('maps HTTP 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, {
          errors: [{ code: 99, description: 'Internal error' }],
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
        errorResponse(422, {
          errors: [
            {
              code: 21,
              description: 'Bad request (phone number has unknown format)',
              parameter: 'recipients',
            },
          ],
        }),
      );

      try {
        await connector.send({ to: 'invalid', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(422);
        expect(e.providerCode).toBe('invalid_request');
        expect(e.providerMessage).toBe(
          'Bad request (phone number has unknown format)',
        );
      }
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
    it('should have id "messagebird" and channelType SMS', () => {
      expect(connector.id).toBe('messagebird');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('should send a JSON message with AccessKey auth and return { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello from MessageBird!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://rest.messagebird.com/messages');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'AccessKey live_abc123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.originator).toBe('MyApp');
      expect(body.body).toBe('Hello from MessageBird!');
      expect(body.recipients).toEqual(['+15559876543']);

      expect(result).toEqual({ id: 'mbird-msg-123', date: expect.any(String) });
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
      expect(body.originator).toBe('+15550000000');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { to: '+15559876543', content: 'Hello!' },
        { _passthrough: { body: { reference: 'my-ref-123' } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.reference).toBe('my-ref-123');
      expect(body.originator).toBe('MyApp');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [
              {
                code: 21,
                description: 'Bad request (phone number has unknown format)',
                parameter: 'recipients',
              },
            ],
          }),
          { status: 422 },
        ),
      );

      try {
        await connector.sendMessage({ to: 'invalid', content: 'Hello' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(422);
        // Brownfield now routes through canonical mapping
        expect(connectorErr.providerCode).toBe('invalid_request');
        expect(connectorErr.providerMessage).toBe(
          'Bad request (phone number has unknown format)',
        );
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
