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
      // FCM Message targets are "mutually exclusive fields. At most one of the
      // fields will be set" — the passthrough topic replaces the seeded token.
      expect(body.message.token).toBeUndefined();

      const headers = reqInit.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('v');
      // Authorization is preserved (passthrough doesn't clobber connector headers
      // because connector headers come first; passthrough wins for duplicates).
      expect(headers.Authorization).toBe('Bearer tk');
    });

    // projects.messages: "Target to send a message to. The following is a list
    // of mutually exclusive fields. At most one of the fields will be set":
    // token, fid, topic, condition.
    it.each([
      [{ condition: "'a' in topics" }, 'condition'],
      [{ fid: 'fid-123' }, 'fid'],
    ] as const)('a passthrough %o target drops the seeded token', async (target, key) => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());
      await new FcmPushConnector(buildConfig()).send({
        to: 'device-token-1',
        title: 'T',
        _passthrough: { body: { message: { ...target } } },
      });
      const msg = (JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string) as {
        message: Record<string, unknown>;
      }).message;
      expect(msg[key]).toBe((target as Record<string, string>)[key]);
      expect(msg).not.toHaveProperty('token');
    });

    it('an empty `to` sends no token field (topic-only send)', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());
      await new FcmPushConnector(buildConfig()).send({
        to: '',
        title: 'T',
        _passthrough: { body: { message: { topic: 'news' } } },
      });
      const msg = (JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string) as {
        message: Record<string, unknown>;
      }).message;
      expect(msg).toEqual(expect.objectContaining({ topic: 'news' }));
      expect(msg).not.toHaveProperty('token');
    });

    it('an unusable privateKey → ConnectorError(auth_failed) naming no key material; nothing sent', async () => {
      const connector = new FcmPushConnector(buildConfig({ privateKey: 'not-a-pem-value' }));
      const err = await connector.send({ to: 't', title: 'T' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      const ce = err as ConnectorError;
      expect(ce.providerCode).toBe('auth_failed');
      expect(ce.message).not.toContain('not-a-pem-value');
      expect(JSON.stringify(ce.cause)).not.toContain('not-a-pem-value');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('an OAuth transport failure → ConnectorError(provider_unavailable), not a raw rejection', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
      const err = await new FcmPushConnector(buildConfig()).send({ to: 't', title: 'T' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).providerCode).toBe('provider_unavailable');
    });

    // Google's token endpoint: invalid_grant / invalid_client are 400/401;
    // a 429 or 5xx is the endpoint, not the credential.
    it.each([
      [400, 'auth_failed'],
      [401, 'auth_failed'],
      [429, 'rate_limited'],
      [500, 'provider_unavailable'],
      [503, 'provider_unavailable'],
    ] as const)('OAuth token exchange HTTP %i → %s', async (status, expected) => {
      mockFetch.mockResolvedValueOnce(new Response('{"error":"x"}', { status }));
      const err = await new FcmPushConnector(buildConfig()).send({ to: 't', title: 'T' }).catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe(expected);
      expect((err as ConnectorError).statusCode).toBe(status);
    });

    it('FCM send HTTP 502 → provider_unavailable (every 5xx)', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmErrorResponse(502, {}));
      const err = await new FcmPushConnector(buildConfig()).send({ to: 't', title: 'T' }).catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe('provider_unavailable');
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

        const stored = hook.store.get('fcm:test-project:test@test-project.iam.gserviceaccount.com');
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
          'fcm:test-project:test@test-project.iam.gserviceaccount.com': {
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
          'fcm:test-project:test@test-project.iam.gserviceaccount.com': {
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
        expect(hook.store.get('fcm:test-project:test@test-project.iam.gserviceaccount.com')?.token).toBe('tk-new');
        expect(hook.setSpy).toHaveBeenCalledTimes(1);

        // FCM call uses the freshly-minted token, not the stale one.
        const [, init] = mockFetch.mock.calls[1]!;
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tk-new');
      });

      it('cache key is fcm:<projectId>:<clientEmail> — includes the service-account identity', async () => {
        const hook = createTokenCacheMock();

        mockFetch
          .mockResolvedValueOnce(oauthSuccessResponse())
          .mockResolvedValueOnce(fcmSuccessResponse());

        const connector = new FcmPushConnector(buildConfig({ tokenCache: hook }));
        await connector.send({ to: 'd', title: 't', body: 'b' });

        expect(hook.getSpy).toHaveBeenCalledWith('fcm:test-project:test@test-project.iam.gserviceaccount.com');
      });

      it('vendor rejects cached token (401): throws auth_failed; hook NOT evicted by wrapper', async () => {
        const hook = createTokenCacheMock({
          'fcm:test-project:test@test-project.iam.gserviceaccount.com': {
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
        expect(hook.store.get('fcm:test-project:test@test-project.iam.gserviceaccount.com')?.token).toBe('stale-but-not-expired');
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

    it('throws auth_failed when the OAuth exchange returns a 200 with no access_token (never Bearer undefined)', async () => {
      // A garbage/token-less 200 must not flow through as `Bearer undefined`.
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ token_type: 'Bearer', expires_in: 3599 }), { status: 200 }),
      );

      const connector = new FcmPushConnector(buildConfig());
      await expect(connector.send({ to: 'd', title: 't', body: 'b' })).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'auth_failed',
      });
      // Only the OAuth call happened — no FCM send with a bogus bearer.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Novu-compatible `sendMessage()` surface
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

    it('reuses a tokenCache hit like .send() (no OAuth round-trip)', async () => {
      const hook = createTokenCacheMock({
        'fcm:test-project:test@test-project.iam.gserviceaccount.com': {
          token: 'cached-tk',
          expiresAt: Date.now() + 60_000,
        },
      });
      mockFetch.mockResolvedValueOnce(fcmSuccessResponse());

      await new FcmPushConnector(buildConfig({ tokenCache: hook })).sendMessage({ ...defaultOptions });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]![0]).toBe(FCM_SEND_URL);
      expect((mockFetch.mock.calls[0]![1] as RequestInit).headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer cached-tk' }),
      );
    });

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
        // Both targets failed the same way (transport), so that code survives
        // instead of a synthetic 500.
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.statusCode).toBeNull();
      }
    });

    it('all targets failing with different codes → unknown, per-target errors on cause.errors', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmErrorResponse(404, { error: { status: 'NOT_FOUND', message: 'unregistered' } }))
        .mockResolvedValueOnce(fcmErrorResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }));
      const err = (await new FcmPushConnector(buildConfig())
        .sendMessage({ ...defaultOptions, target: ['t1', 't2'] })
        .catch((e: unknown) => e)) as ConnectorError;
      expect(err.providerCode).toBe('unknown');
      expect(err.statusCode).toBeNull();
      expect((err.cause as { errors: unknown[] }).errors).toHaveLength(2);
    });

    // FCM targets are mutually exclusive: a passthrough condition/fid is ONE
    // send to that target, never a token send.
    it('a passthrough condition is a single condition send with no token', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());
      await new FcmPushConnector(buildConfig()).sendMessage(
        { ...defaultOptions, target: ['t1', 't2'] },
        { _passthrough: { body: { condition: "'a' in topics" } } },
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const msg = (JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string) as {
        message: Record<string, unknown>;
      }).message;
      expect(msg.condition).toBe("'a' in topics");
      expect(msg).not.toHaveProperty('token');
    });

    // FCM v1: fcm_options / webpush are message fields; icon, color, tag, sound
    // live in android.notification; sound/badge in apns.payload.aps.
    it('type "data": icon/color/tag/sound/badge are NOT mapped, so the message stays silent', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());
      await new FcmPushConnector(buildConfig()).sendMessage({
        ...defaultOptions,
        target: ['t1'],
        overrides: { type: 'data', icon: 'ic_n', color: '#ff0000', tag: 'grp', sound: 'ding', badge: 2 },
      });
      const msg = (JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string) as {
        message: Record<string, unknown>;
      }).message;
      expect(msg).not.toHaveProperty('notification');
      expect(msg).not.toHaveProperty('android');
      expect(msg).not.toHaveProperty('apns');
      expect(msg.data).toBeDefined();
    });

    it('maps fcmOptions, webPush, icon/color/tag/sound/badge overrides to their FCM v1 fields', async () => {
      mockFetch
        .mockResolvedValueOnce(oauthSuccessResponse())
        .mockResolvedValueOnce(fcmSuccessResponse());
      await new FcmPushConnector(buildConfig()).sendMessage({
        ...defaultOptions,
        target: ['t1'],
        overrides: {
          fcmOptions: { analytics_label: 'L' },
          webPush: { headers: { Urgency: 'high' } },
          icon: 'ic_n',
          color: '#ff0000',
          tag: 'grp',
          sound: 'ding',
          badge: 2,
        },
      });
      const msg = (JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string) as {
        message: Record<string, unknown>;
      }).message;
      expect(msg.fcm_options).toEqual({ analytics_label: 'L' });
      expect(msg.webpush).toEqual({ headers: { Urgency: 'high' } });
      expect(msg.android).toEqual({ notification: { icon: 'ic_n', color: '#ff0000', tag: 'grp', sound: 'ding' } });
      expect(msg.apns).toEqual({ payload: { aps: { sound: 'ding', badge: 2 } } });
    });
  });
});
