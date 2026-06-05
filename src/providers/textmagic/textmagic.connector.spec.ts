import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { TextmagicSmsConnector } from './textmagic.connector';
import type { TextmagicConfig } from './textmagic.config';
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

const defaultConfig: TextmagicConfig = {
  username: 'tm-user',
  apiKey: 'tm-api-key-123',
  from: 'MyCompany',
};

function sendSuccessResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 456,
      href: '/api/v2/messages/456',
      type: 'message',
      sessionId: 789,
      messageId: 12345,
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

describe('TextmagicSmsConnector', () => {
  let connector: TextmagicSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new TextmagicSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path: POSTs form-urlencoded body with two-header auth and returns providerMessageId from `id`', async () => {
      mockFetch.mockResolvedValueOnce(sendSuccessResponse());

      const result = await connector.send({
        to: '+15559876543',
        body: 'Hello from Textmagic!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://rest.textmagic.com/api/v2/messages');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-TM-Username': 'tm-user',
          'X-TM-Key': 'tm-api-key-123',
        }),
      );

      // Body is form-urlencoded — parse via URLSearchParams.
      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('text')).toBe('Hello from Textmagic!');
      expect(params.get('phones')).toBe('+15559876543');
      expect(params.get('from')).toBe('MyCompany');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: '456',
        raw: expect.objectContaining({ id: 456 }),
      });
    });

    it('serializes narrowed Textmagic fields with camelCase wire keys and stringifies numbers/booleans (cutExtra → "1")', async () => {
      mockFetch.mockResolvedValueOnce(sendSuccessResponse());

      await connector.send({
        to: '+15559876543',
        body: 'scheduled',
        templateId: 42,
        sendingTime: 1609459200,
        tz: 'America/New_York',
        partsCount: 1,
        referenceId: 9001,
        rrule: 'FREQ=DAILY;COUNT=3',
        cutExtra: true,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('templateId')).toBe('42');
      expect(params.get('sendingTime')).toBe('1609459200');
      expect(params.get('tz')).toBe('America/New_York');
      expect(params.get('partsCount')).toBe('1');
      expect(params.get('referenceId')).toBe('9001');
      expect(params.get('rrule')).toBe('FREQ=DAILY;COUNT=3');
      // cutExtra is encoded as Textmagic's documented '1' / '0' (NOT 'true' / 'false').
      expect(params.get('cutExtra')).toBe('1');
    });

    it('uses `phones` wire key for the recipient (not `to`) — single-recipient maps input.to verbatim', async () => {
      mockFetch.mockResolvedValueOnce(sendSuccessResponse());

      await connector.send({ to: '+15559876543', body: 'Hi' });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('phones')).toBe('+15559876543');
      // sanity: no `to` wire field
      expect(params.get('to')).toBeNull();
    });

    it('maps HTTP 422 → invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(422, { code: 9, message: 'Invalid phone number' }),
      );

      try {
        await connector.send({ to: '+1invalid', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(422);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toBe('Invalid phone number');
      }
    });

    it('honors `_passthrough` — body, headers, and query merged into the request', async () => {
      mockFetch.mockResolvedValueOnce(sendSuccessResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hi',
        _passthrough: {
          body: { sendingTime: 1609459200 },
          headers: { 'X-Trace-Id': 't-1' },
          query: { dry_run: 'true' },
        },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://rest.textmagic.com/api/v2/messages?dry_run=true',
      );
      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('sendingTime')).toBe('1609459200');
      expect(params.get('phones')).toBe('+15559876543');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Trace-Id': 't-1' }),
      );
    });

    // ------------------------------------------------------------------------
    // Additional `.send()` coverage (auth/rate-limit/network/`messageId` fallback)
    // ------------------------------------------------------------------------

    it('uses per-call from when provided, overriding config.from', async () => {
      mockFetch.mockResolvedValueOnce(sendSuccessResponse());

      await connector.send({
        from: '+15550000000',
        to: '+15559876543',
        body: 'Hi',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('from')).toBe('+15550000000');
    });

    it('maps HTTP 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, { code: 401, message: 'Authentication failed' }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('Authentication failed');
      }
    });

    it('maps HTTP 429 with Retry-After: 30 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '30',
          errorBody: { code: 429, message: 'Too Many Requests' },
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
          retryAfter: '30',
          retryAfterSeconds: 30,
        });
      }
    });

    it('maps HTTP 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, { message: 'Internal Server Error' }),
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
        errorResponse(400, { code: 'bad_input', message: 'Bad request' }),
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

    it('falls back to `messageId` when `id` is absent on the response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ messageId: 99999, href: '/x', type: 'message', sessionId: 1 }),
          { status: 200 },
        ),
      );

      const result = await connector.send({
        to: '+15559876543',
        body: 'Hi',
      });

      expect(result.providerMessageId).toBe('99999');
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    function brownfieldSuccessResponse(): Response {
      return new Response(
        JSON.stringify({
          id: 456,
          href: '/api/v2/messages/456',
          type: 'message',
          sessionId: 789,
          messageId: 12345,
        }),
        { status: 200 },
      );
    }

    it('should have id "textmagic" and channelType SMS', () => {
      expect(connector.id).toBe('textmagic');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('should send a JSON message with X-TM auth headers and return { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(brownfieldSuccessResponse());

      const result = await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello from Textmagic!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://rest.textmagic.com/api/v2/messages');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          'X-TM-Username': 'tm-user',
          'X-TM-Key': 'tm-api-key-123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.text).toBe('Hello from Textmagic!');
      expect(body.phones).toBe('+15559876543');
      expect(body.from).toBe('MyCompany');

      expect(result).toEqual({ id: '12345', date: expect.any(String) });
    });

    it('should use options.from over config.from', async () => {
      mockFetch.mockResolvedValueOnce(brownfieldSuccessResponse());

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

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(brownfieldSuccessResponse());

      await connector.sendMessage(
        { to: '+15559876543', content: 'Hello!' },
        { _passthrough: { body: { sendingTime: 1609459200 } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.sendingTime).toBe(1609459200);
      expect(body.phones).toBe('+15559876543');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 401, message: 'Authentication failed' }),
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
        expect(connectorErr.providerMessage).toBe('Authentication failed');
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
