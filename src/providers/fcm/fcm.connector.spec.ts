import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { FcmPushConnector } from './fcm.connector';
import type { FcmConfig } from './fcm.config';
import { ChannelTypeEnum } from '../../types';
import type { IPushOptions } from '../../types';
import { ConnectorError } from '../../utils';
import { createRetryAfterFixture } from '../../test-utils';
import { createTokenCacheMock } from '../../test-utils';

const mockFetch = vi.fn();

// Throwaway RSA private key generated once at suite startup. Never committed.
let TEST_PRIVATE_KEY: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  TEST_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function buildConfig(overrides: Partial<FcmConfig> = {}): FcmConfig {
  return {
    projectId: 'test-project',
    clientEmail: 'test@test-project.iam.gserviceaccount.com',
    privateKey: TEST_PRIVATE_KEY,
    ...overrides,
  };
}

const FCM_SEND_URL =
  'https://fcm.googleapis.com/v1/projects/test-project/messages:send';
const OAUTH_URL = 'https://oauth2.googleapis.com/token';

function oauthSuccessResponse(token = 'tk', expiresIn = 3599): Response {
  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
    }),
    { status: 200 },
  );
}

function fcmSuccessResponse(name = 'projects/test-project/messages/0:abc123'): Response {
  return new Response(JSON.stringify({ name }), { status: 200 });
}

function fcmErrorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('FcmPushConnector', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ===========================================================================
  // Identity
  // ===========================================================================

  it('has id "fcm" and channelType PUSH', () => {
    const connector = new FcmPushConnector(buildConfig());
    expect(connector.id).toBe('fcm');
    expect(connector.channelType).toBe(ChannelTypeEnum.PUSH);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('stateless default (no tokenCache): mints fresh token + sends, returns canonical PushSendResult', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse('tk', 3599))
        .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:abc'));

      const connector = new FcmPushConnector(buildConfig());
      const result = await connector.send({
        to: 'device-token-1',
        title: 'Hello',
        body: 'World',
      });

      // 2 fetch calls: 1 OAuth exchange + 1 FCM send.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]![0]).toBe(OAUTH_URL);
      expect(mockFetch.mock.calls[1]![0]).toBe(FCM_SEND_URL);

      // FCM send request: Authorization header + JSON body shape.
      const [, init] = mockFetch.mock.calls[1]!;
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer tk',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as {
        message: Record<string, unknown>;
      };
      expect(body.message.token).toBe('device-token-1');
      expect(body.message.notification).toEqual({ title: 'Hello', body: 'World' });

      // Canonical result shape.
      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'projects/test-project/messages/0:abc',
        raw: { name: 'projects/test-project/messages/0:abc' },
      });
    });

    it('stateless default: every .send() triggers a token exchange + FCM send (no hidden caching)', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse('tk1'))
        .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:m1'))
        .mockResolvedValueOnce(oauthSuccessResponse('tk2'))
        .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:m2'));

      const connector = new FcmPushConnector(buildConfig());
      await connector.send({ to: 'd1', title: 'a', body: 'b' });
      await connector.send({ to: 'd2', title: 'a', body: 'b' });

      expect(mockFetch).toHaveBeenCalledTimes(4);
      // The second send must have re-exchanged the JWT.
      expect(mockFetch.mock.calls[2]![0]).toBe(OAUTH_URL);
      expect(mockFetch.mock.calls[3]![0]).toBe(FCM_SEND_URL);
    });

    // -------------------------------------------------------------------------
    // Field-mapping
    // -------------------------------------------------------------------------

    it('maps input.data → message.data verbatim (Record<string, string>)', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());

      const connector = new FcmPushConnector(buildConfig());
      await connector.send({
        to: 'device-token-1',
        title: 'T',
        body: 'B',
        data: { key1: 'value1', key2: '42' },
      });

      const [, init] = mockFetch.mock.calls[1]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        message: { data?: Record<string, string> };
      };
      expect(body.message.data).toEqual({ key1: 'value1', key2: '42' });
    });

    it('maps input.ttl seconds → message.android.ttl as "<n>s" string', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());

      const connector = new FcmPushConnector(buildConfig());
      await connector.send({
        to: 'device-token-1',
        title: 'T',
        body: 'B',
        ttl: 600,
      });

      const [, init] = mockFetch.mock.calls[1]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        message: { android?: { ttl?: string } };
      };
      expect(body.message.android?.ttl).toBe('600s');
    });

    it('forwards android/apns/webpush/fcm_options blocks verbatim', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());

      const connector = new FcmPushConnector(buildConfig());
      await connector.send({
        to: 'device-token-1',
        title: 'T',
        body: 'B',
        android: { priority: 'HIGH', collapse_key: 'k' },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
        webpush: { headers: { 'TTL': '60' }, notification: { icon: '/icon.png' } },
        fcm_options: { analytics_label: 'campaign1' },
      });

      const [, init] = mockFetch.mock.calls[1]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        message: Record<string, unknown>;
      };
      expect(body.message.android).toEqual({ priority: 'HIGH', collapse_key: 'k' });
      expect(body.message.apns).toEqual({
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default' } },
      });
      expect(body.message.webpush).toEqual({
        headers: { TTL: '60' },
        notification: { icon: '/icon.png' },
      });
      expect(body.message.fcm_options).toEqual({ analytics_label: 'campaign1' });
    });

    it('merges _passthrough.body into the FCM request body (deep)', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());

      const connector = new FcmPushConnector(buildConfig());
      await connector.send({
        to: 'device-token-1',
        title: 'T',
        body: 'B',
        _passthrough: {
          body: { message: { topic: 'breaking-news' } },
          headers: { 'X-Custom': 'v' },
        },
      });

      const [, init] = mockFetch.mock.calls[1]!;
      const reqInit = init as RequestInit;
      const body = JSON.parse(reqInit.body as string) as {
        message: Record<string, unknown>;
      };
      expect(body.message.topic).toBe('breaking-news');
      expect(body.message.token).toBe('device-token-1');

      const headers = reqInit.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('v');
      // Authorization is preserved (passthrough doesn't clobber connector headers
      // because connector headers come first; passthrough wins for duplicates).
      expect(headers.Authorization).toBe('Bearer tk');
    });

    // -------------------------------------------------------------------------
    // Token-cache hook paths
    // -------------------------------------------------------------------------

    describe('tokenCache hook integration', () => {
      it('cache-miss: hook.get returns null → mints fresh, calls hook.set with epoch-ms expiresAt', async () => {
        const hook = createTokenCacheMock();
        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse('fresh-tk', 3599))
          .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:m'));

        const before = Date.now();
        const connector = new FcmPushConnector(buildConfig({ tokenCache: hook }));
        const result = await connector.send({
          to: 'device-token-1',
          title: 'hi',
          body: 'world',
        });
        const after = Date.now();

        expect(result.providerMessageId).toBe('projects/test-project/messages/0:m');
        expect(hook.getSpy).toHaveBeenCalledTimes(1);
        expect(hook.setSpy).toHaveBeenCalledTimes(1);

        const stored = hook.store.get('fcm:test-project');
        expect(stored).toBeDefined();
        expect(stored!.token).toBe('fresh-tk');
        // expiresAt must be ~Date.now() + 3599 * 1000 (give or take wall-clock drift).
        expect(stored!.expiresAt).toBeGreaterThanOrEqual(before + 3599 * 1000);
        expect(stored!.expiresAt).toBeLessThanOrEqual(after + 3599 * 1000);

        // Both fetch calls happened (OAuth + FCM).
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('cache-hit: hook.get returns unexpired entry → reuses, NO token-exchange call, NO hook.set call', async () => {
        // Seed the cache via the constructor so setSpy starts at 0 (explicit key).
        const hook = createTokenCacheMock({
          'fcm:test-project': {
            token: 'cached-token',
            expiresAt: Date.now() + 60_000,
          },
        });

        mockFetch.mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:hit'));

        const connector = new FcmPushConnector(buildConfig({ tokenCache: hook }));
        await connector.send({
          to: 'device-token-1',
          title: 'hi',
          body: 'world',
        });

        // Only ONE fetch call — the FCM send. NO OAuth exchange.
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0]![0]).toBe(FCM_SEND_URL);

        // Authorization header used the cached token.
        const [, init] = mockFetch.mock.calls[0]!;
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer cached-token');

        // hook.get called once, hook.set NOT called.
        expect(hook.getSpy).toHaveBeenCalledTimes(1);
        expect(hook.setSpy).not.toHaveBeenCalled();
      });

      it('cache-stale: hook.get returns expired entry → treats as miss, mints fresh, calls hook.set', async () => {
        const hook = createTokenCacheMock({
          'fcm:test-project': {
            token: 'old-token',
            expiresAt: Date.now() - 1, // already expired
          },
        });

        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse('tk-new', 3599))
          .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:stale'));

        const connector = new FcmPushConnector(buildConfig({ tokenCache: hook }));
        await connector.send({
          to: 'device-token-1',
          title: 'hi',
          body: 'world',
        });

        // Both fetches happened (OAuth re-exchange + FCM send).
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[0]![0]).toBe(OAUTH_URL);

        // Hook updated with the new token.
        expect(hook.store.get('fcm:test-project')?.token).toBe('tk-new');
        expect(hook.setSpy).toHaveBeenCalledTimes(1);

        // FCM call uses the freshly-minted token, not the stale one.
        const [, init] = mockFetch.mock.calls[1]!;
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tk-new');
      });

      it('cache key is exactly "fcm:" + projectId — no salt, no time component', async () => {
        const hook = createTokenCacheMock();

        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse())
          .mockResolvedValueOnce(fcmSuccessResponse());

        const connector = new FcmPushConnector(buildConfig({ tokenCache: hook }));
        await connector.send({ to: 'd', title: 't', body: 'b' });

        expect(hook.getSpy).toHaveBeenCalledWith('fcm:test-project');
      });

      it('vendor rejects cached token (401): throws auth_failed; hook NOT evicted by wrapper', async () => {
        const hook = createTokenCacheMock({
          'fcm:test-project': {
            token: 'stale-but-not-expired',
            expiresAt: Date.now() + 60_000,
          },
        });
        const setCallsBefore = hook.setSpy.mock.calls.length;

        mockFetch.mockResolvedValueOnce(
          fcmErrorResponse(401, {
            error: { status: 'UNAUTHENTICATED', message: 'invalid token' },
          }),
        );

        const connector = new FcmPushConnector(buildConfig({ tokenCache: hook }));
        await expect(
          connector.send({ to: 'device-token-1', title: 'hi', body: 'world' }),
        ).rejects.toMatchObject({
          name: 'ConnectorError',
          providerCode: 'auth_failed',
          statusCode: 401,
        });

        // Wrapper did NOT call hook.set on auth-fail (consumer-owned eviction).
        expect(hook.setSpy.mock.calls.length).toBe(setCallsBefore);
        // Entry remains intact in the consumer's cache.
        expect(hook.store.get('fcm:test-project')?.token).toBe('stale-but-not-expired');
      });
    });

    // -------------------------------------------------------------------------
    // Error mapping
    // -------------------------------------------------------------------------

    describe('error mapping', () => {
      it.each<[number, string, string]>([
        [401, 'UNAUTHENTICATED', 'auth_failed'],
        [403, 'SENDER_ID_MISMATCH', 'auth_failed'],
        [400, 'INVALID_ARGUMENT', 'invalid_request'],
        [404, 'NOT_FOUND', 'invalid_recipient'],
        [429, 'QUOTA_EXCEEDED', 'rate_limited'],
        [500, 'INTERNAL', 'provider_unavailable'],
        [503, 'UNAVAILABLE', 'provider_unavailable'],
      ])(
        'maps HTTP %i + error.status=%s → providerCode=%s',
        async (status, fcmStatus, expectedCode) => {
          mockFetch
            .mockResolvedValueOnce(oauthSuccessResponse())
            .mockResolvedValueOnce(
              fcmErrorResponse(status, {
                error: { status: fcmStatus, message: 'vendor msg' },
              }),
            );

          const connector = new FcmPushConnector(buildConfig());
          try {
            await connector.send({ to: 'd', title: 't', body: 'b' });
            expect.unreachable('Should have thrown');
          } catch (err) {
            expect(err).toBeInstanceOf(ConnectorError);
            const e = err as ConnectorError;
            expect(e.statusCode).toBe(status);
            expect(e.providerCode).toBe(expectedCode);
            expect(e.providerMessage).toContain('vendor msg');
          }
        },
      );

      it('maps an unrecognized status (e.g. 418) to unknown', async () => {
        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse())
          .mockResolvedValueOnce(
            fcmErrorResponse(418, { error: { status: 'WEIRD', message: 'teapot' } }),
          );

        const connector = new FcmPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          const e = err as ConnectorError;
          expect(e.statusCode).toBe(418);
          expect(e.providerCode).toBe('unknown');
        }
      });

      it('handles error response with no parseable JSON body', async () => {
        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse())
          .mockResolvedValueOnce(new Response('garbage', { status: 500 }));

        const connector = new FcmPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          const e = err as ConnectorError;
          expect(e.statusCode).toBe(500);
          expect(e.providerCode).toBe('provider_unavailable');
          expect(e.providerMessage).toContain('FCM HTTP 500');
        }
      });

      it('wraps network errors as provider_unavailable with statusCode=null', async () => {
        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse())
          .mockRejectedValueOnce(new Error('ETIMEDOUT'));

        const connector = new FcmPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(ConnectorError);
          const e = err as ConnectorError;
          expect(e.statusCode).toBeNull();
          expect(e.providerCode).toBe('provider_unavailable');
        }
      });
    });

    // -------------------------------------------------------------------------
    // Retry-After parsing
    // -------------------------------------------------------------------------

    describe('Retry-After surfacing (, retry is consumer policy)', () => {
      it('parses integer Retry-After into cause.retryAfter and cause.retryAfterSeconds', async () => {
        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse())
          .mockResolvedValueOnce(
            createRetryAfterFixture({
              status: 429,
              retryAfter: '30',
              errorBody: { error: { status: 'QUOTA_EXCEEDED', message: 'Slow down' } },
            }),
          );

        const connector = new FcmPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          const e = err as ConnectorError;
          expect(e.providerCode).toBe('rate_limited');
          expect(e.providerMessage).toBe('Slow down');
          expect(e.cause as Record<string, unknown>).toMatchObject({
            retryAfter: '30',
            retryAfterSeconds: 30,
          });
        }
      });

      it('does not append Retry-After text when the header is absent', async () => {
        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse())
          .mockResolvedValueOnce(
            createRetryAfterFixture({
              status: 429,
              errorBody: { error: { status: 'QUOTA_EXCEEDED', message: 'Slow down' } },
            }),
          );

        const connector = new FcmPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          const e = err as ConnectorError;
          expect(e.providerMessage).toBe('Slow down');
        }
      });
    });

    // -------------------------------------------------------------------------
    // OAuth-exchange errors (failure during token mint, before FCM send)
    // -------------------------------------------------------------------------

    it('throws auth_failed when the OAuth exchange fails', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('invalid_grant', { status: 400 }),
      );

      const connector = new FcmPushConnector(buildConfig());
      try {
        await connector.send({ to: 'd', title: 't', body: 'b' });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('auth_failed');
      }
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    const defaultOptions: IPushOptions = {
      target: ['device-token-1'],
      title: 'Test Title',
      content: 'Test Body',
      payload: { key1: 'value1', key2: 42 },
      subscriber: {},
      step: { digest: false, events: undefined, total_count: undefined },
    };

    it('mints a fresh OAuth token then POSTs the FCM message', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse('legacy-tk'))
        .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:legacy'));

      const connector = new FcmPushConnector(buildConfig());
      const result = await connector.sendMessage({ ...defaultOptions });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]![0]).toBe(OAUTH_URL);

      const [url, init] = mockFetch.mock.calls[1]!;
      expect(url).toBe(FCM_SEND_URL);
      const reqInit = init as RequestInit;
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer legacy-tk',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as {
        message: Record<string, unknown>;
      };
      expect(body.message.token).toBe('device-token-1');
      expect(body.message.notification).toEqual({
        title: 'Test Title',
        body: 'Test Body',
      });

      expect(result).toEqual({
        ids: ['projects/test-project/messages/0:legacy'],
        date: expect.any(String),
      });
    });

    it('sends one POST per target token for multi-recipient sends', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:m1'))
        .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:m2'))
        .mockResolvedValueOnce(fcmSuccessResponse('projects/test-project/messages/0:m3'));

      const connector = new FcmPushConnector(buildConfig());
      const result = await connector.sendMessage({
        ...defaultOptions,
        target: ['token-a', 'token-b', 'token-c'],
      });

      // 1 OAuth + 3 sends
      expect(mockFetch).toHaveBeenCalledTimes(4);

      const tokens = mockFetch.mock.calls
        .slice(1)
        .map(([, init]) => {
          const body = JSON.parse((init as RequestInit).body as string) as {
            message: { token: string };
          };
          return body.message.token;
        });
      expect(tokens).toEqual(
        expect.arrayContaining(['token-a', 'token-b', 'token-c']),
      );

      expect(result.ids).toHaveLength(3);
    });

    it('builds a data message when overrides.type is "data"', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());

      const connector = new FcmPushConnector(buildConfig());
      await connector.sendMessage({
        ...defaultOptions,
        overrides: { type: 'data' },
      });

      const [, init] = mockFetch.mock.calls[1]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        message: Record<string, unknown>;
      };
      expect(body.message.data).toEqual(
        expect.objectContaining({
          title: 'Test Title',
          body: 'Test Body',
          key1: 'value1',
          key2: '42',
        }),
      );
      expect(body.message.notification).toBeUndefined();
    });

    it('sends a topic-based message when topic is set via passthrough', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(
          fcmSuccessResponse('projects/test-project/messages/0:topic-msg'),
        );

      const connector = new FcmPushConnector(buildConfig());
      const result = await connector.sendMessage(
        { ...defaultOptions },
        { _passthrough: { body: { topic: 'breaking-news' } } },
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, init] = mockFetch.mock.calls[1]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        message: Record<string, unknown>;
      };
      expect(body.message.topic).toBe('breaking-news');
      expect(body.message.token).toBeUndefined();

      expect(result).toEqual({
        ids: ['projects/test-project/messages/0:topic-msg'],
        date: expect.any(String),
      });
    });

    it('throws ConnectorError when all targets fail', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockRejectedValueOnce(new Error('FCM send failed'))
        .mockRejectedValueOnce(new Error('FCM send failed again'));

      const connector = new FcmPushConnector(buildConfig());
      try {
        await connector.sendMessage({
          ...defaultOptions,
          target: ['t1', 't2'],
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.message).toBe('All 2 FCM message(s) failed to send');
        expect(e.statusCode).toBe(500);
      }
    });
  });
});
