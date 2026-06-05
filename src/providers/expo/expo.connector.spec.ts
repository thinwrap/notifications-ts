import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { ExpoPushConnector } from './expo.connector';
import type { ExpoConfig } from './expo.config';
import type { IPushOptions } from '../../types';
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

const defaultConfig: ExpoConfig = {
  accessToken: 'expo-test-token',
};

const defaultOptions: IPushOptions = {
  target: ['ExponentPushToken[test-token-1]'],
  title: 'Test Title',
  content: 'Test Body',
  payload: { key1: 'value1' },
  subscriber: {},
  step: { digest: false, events: undefined, total_count: undefined },
};

function successResponse(ids: string[] = ['ticket-id-1']) {
  return new Response(
    JSON.stringify({ data: ids.map((id) => ({ status: 'ok' as const, id })) }),
    { status: 200 }
  );
}

function singleTicketResponse(
  ticket: { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string } },
) {
  return new Response(JSON.stringify({ data: ticket }), { status: 200 });
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('ExpoPushConnector', () => {
  let connector: ExpoPushConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new ExpoPushConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('happy path with accessToken: 200 OK, ticket status "ok" → result has providerMessageId and Bearer auth', async () => {
      mockFetch.mockResolvedValueOnce(
        singleTicketResponse({ status: 'ok', id: 'receipt-1' }),
      );

      const result = await connector.send({
        to: 'ExponentPushToken[xxx]',
        title: 'hi',
        body: 'world',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://exp.host/--/api/v2/push/send');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: 'Bearer expo-test-token',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.to).toBe('ExponentPushToken[xxx]');
      expect(body.title).toBe('hi');
      expect(body.body).toBe('world');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'receipt-1',
        raw: expect.objectContaining({
          data: expect.objectContaining({ status: 'ok', id: 'receipt-1' }),
        }),
      });
    });

    it('happy path without accessToken → no Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(
        singleTicketResponse({ status: 'ok', id: 'receipt-2' }),
      );
      const noAuthConnector = new ExpoPushConnector({});

      await noAuthConnector.send({
        to: 'ExponentPushToken[yyy]',
        title: 'hi',
        body: 'world',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('DeviceNotRegistered ticket (HTTP 200 + status: error) → throws ConnectorError with invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        singleTicketResponse({
          status: 'error',
          message: 'device not registered',
          details: { error: 'DeviceNotRegistered' },
        }),
      );

      try {
        await connector.send({
          to: 'ExponentPushToken[zzz]',
          title: 'hi',
          body: 'world',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.statusCode).toBe(200);
        expect(e.providerMessage).toContain('device not registered');
      }
    });

    it('HTTP 429 with Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { errors: [{ message: 'rate limited' }] },
        }),
      );

      try {
        await connector.send({
          to: 'ExponentPushToken[a]',
          title: 'hi',
          body: 'world',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('rate_limited');
        expect(e.statusCode).toBe(429);
        expect(e.providerMessage).toBe('rate limited');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('_passthrough.headers merged into outgoing request; _passthrough.body merged into JSON body', async () => {
      mockFetch.mockResolvedValueOnce(
        singleTicketResponse({ status: 'ok', id: 'r' }),
      );

      await connector.send({
        to: 'ExponentPushToken[a]',
        title: 'hi',
        body: 'world',
        _passthrough: {
          headers: { 'x-custom': 'v' },
          body: { experimentalField: 'on' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'x-custom': 'v' }),
      );
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.experimentalField).toBe('on');
    });

    it('serializes Expo-narrowed fields (priority, channelId, mutableContent, subtitle, interruptionLevel, ttl, badge, sound, data, _displayInForeground, categoryId) as camelCase JSON keys', async () => {
      mockFetch.mockResolvedValueOnce(
        singleTicketResponse({ status: 'ok', id: 'r' }),
      );

      // `data` is typed Record<string, string> per the cross-provider contract
      // this case intentionally exercises runtime passthrough of
      // non-string `data` values, so we cast past the compile-time narrowing.
      await connector.send({
        to: 'ExponentPushToken[a]',
        title: 'hi',
        body: 'world',
        data: { x: 1, nested: { y: 'z' } },
        sound: 'default',
        badge: 7,
        ttl: 120,
        priority: 'high',
        channelId: 'default',
        categoryId: 'message',
        mutableContent: true,
        subtitle: 'sub',
        interruptionLevel: 'time-sensitive',
        _displayInForeground: true,
      } as unknown as Parameters<typeof connector.send>[0]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.data).toEqual({ x: 1, nested: { y: 'z' } });
      expect(body.sound).toBe('default');
      expect(body.badge).toBe(7);
      expect(body.ttl).toBe(120);
      expect(body.priority).toBe('high');
      expect(body.channelId).toBe('default');
      expect(body.categoryId).toBe('message');
      expect(body.mutableContent).toBe(true);
      expect(body.subtitle).toBe('sub');
      expect(body.interruptionLevel).toBe('time-sensitive');
      expect(body._displayInForeground).toBe(true);
    });

    it('wraps fetch network errors as ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await connector.send({
          to: 'ExponentPushToken[a]',
          title: 'hi',
          body: 'world',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.statusCode).toBeNull();
      }
    });

    it('maps HTTP 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, { errors: [{ message: 'unauthorized' }] }),
      );

      try {
        await connector.send({
          to: 'ExponentPushToken[a]',
          title: 'hi',
          body: 'world',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
      }
    });

    it('maps HTTP 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, { errors: [{ message: 'upstream error' }] }),
      );

      try {
        await connector.send({
          to: 'ExponentPushToken[a]',
          title: 'hi',
          body: 'world',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('should have id "expo" and channelType PUSH', () => {
      expect(connector.id).toBe('expo');
      expect(connector.channelType).toBe(ChannelTypeEnum.PUSH);
    });

    it('should send JSON to correct URL with Bearer auth', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage(defaultOptions);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://exp.host/--/api/v2/push/send');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer expo-test-token',
        })
      );

      expect(result).toEqual({ ids: ['ticket-id-1'], date: expect.any(String) });
    });

    it('should not include Authorization header when accessToken is not provided', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const noAuthConnector = new ExpoPushConnector({});
      await noAuthConnector.sendMessage(defaultOptions);

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers).not.toHaveProperty('Authorization');
    });

    it('should include title, body, and data payload in request', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(defaultOptions);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      expect(body.to).toBe('ExponentPushToken[test-token-1]');
      expect(body.title).toBe('Test Title');
      expect(body.body).toBe('Test Body');
      expect(body.data).toEqual({ key1: 'value1' });
    });

    it('should include overrides (sound, badge) in request', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const options: IPushOptions = {
        ...defaultOptions,
        overrides: { sound: 'default', badge: 5 },
      };
      await connector.sendMessage(options);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.sound).toBe('default');
      expect(body.badge).toBe(5);
    });

    it('should handle partial failure: mix of ok and error tickets', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { status: 'ok', id: 'ticket-ok' },
              { status: 'error', message: 'DeviceNotRegistered', details: { error: 'DeviceNotRegistered' } },
            ],
          }),
          { status: 200 }
        )
      );

      const options: IPushOptions = {
        ...defaultOptions,
        target: ['ExponentPushToken[ok]', 'ExponentPushToken[bad]'],
      };

      const result = await connector.sendMessage(options);

      expect(result.ids).toHaveLength(2);
      expect(result.ids).toContain('ticket-ok');
      expect(result.ids).toContain('DeviceNotRegistered');
    });

    it('should throw ConnectorError when all tickets fail', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ status: 'error', message: 'DeviceNotRegistered' }],
          }),
          { status: 200 }
        )
      );

      try {
        await connector.sendMessage(defaultOptions);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.message).toBe('All 1 Expo push message(s) failed');
        expect(connectorErr.providerMessage).toContain('DeviceNotRegistered');
      }
    });

    it('should throw ConnectorError on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ errors: [{ code: 'RATE_LIMIT', message: 'Rate limited' }] }),
          { status: 429 }
        )
      );

      try {
        await connector.sendMessage(defaultOptions);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(429);
        // Brownfield now routes through canonical mapVendorError
        expect(connectorErr.providerCode).toBe('rate_limited');
      }
    });
  });
});
