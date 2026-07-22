import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { ApnsPushConnector } from './apns.connector';
import type { ApnsConfig } from './apns.config';
import { ChannelTypeEnum } from '../../types';
import type { IPushOptions } from '../../types';
import { ConnectorError } from '../../utils';
import { createRetryAfterFixture } from '../../test-utils';
import { createTokenCacheMock } from '../../test-utils';

const mockFetch = vi.fn();

// Throwaway P-256 EC private key generated once at suite startup. Never committed.
let TEST_PRIVATE_KEY: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  TEST_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function buildConfig(overrides: Partial<ApnsConfig> = {}): ApnsConfig {
  return {
    teamId: 'TEAM123ABC',
    keyId: 'KEY456DEF',
    privateKey: TEST_PRIVATE_KEY,
    bundleId: 'com.example.app',
    env: 'sandbox',
    // APNs mandates HTTP/2; the connector fails fast when NO transport is injected
    // (the built-in undici fetch is HTTP/1.1-only). Model a consumer supplying an
    // HTTP/2-capable fetch by injecting the mock here.
    fetch: mockFetch as unknown as typeof fetch,
    ...overrides,
  };
}

const CACHE_KEY = 'apns:TEAM123ABC:KEY456DEF:com.example.app';

function apnsSuccessResponse(apnsId = 'apns-uuid-123'): Response {
  return new Response('', {
    status: 200,
    headers: { 'apns-id': apnsId },
  });
}

function apnsErrorResponse(
  status: number,
  body: { reason?: string } | null,
  headers?: Record<string, string>,
): Response {
  return new Response(body ? JSON.stringify(body) : '', { status, headers });
}

describe('ApnsPushConnector', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ===========================================================================
  // Identity
  // ===========================================================================

  it('has id "apns" and channelType PUSH', () => {
    const connector = new ApnsPushConnector(buildConfig());
    expect(connector.id).toBe('apns');
    expect(connector.channelType).toBe(ChannelTypeEnum.PUSH);
  });

  it('fails fast with invalid_request when no HTTP/2-capable transport is injected (APNs needs HTTP/2)', async () => {
    // No fetch injected → the built-in undici fetch (HTTP/1.1-only) would be used,
    // which APNs rejects. Surface a clear typed error up front, without a network call.
    const connector = new ApnsPushConnector({ ...buildConfig(), fetch: undefined });
    await expect(connector.send({ to: 'device-token', title: 't', body: 'b' })).rejects.toMatchObject({
      name: 'ConnectorError',
      providerCode: 'invalid_request',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('stateless default (no tokenCache): signs fresh JWT + sends, returns canonical PushSendResult', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse('apns-msg-1'));

      const connector = new ApnsPushConnector(buildConfig());
      const result = await connector.send({
        to: 'device-token-1',
        title: 'Hello',
        body: 'World',
      });

      // Single fetch call (APNs JWT signing is purely local crypto — no OAuth exchange).
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.sandbox.push.apple.com/3/device/device-token-1');

      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe('POST');
      const headers = reqInit.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^bearer /);
      expect(headers['apns-topic']).toBe('com.example.app');
      expect(headers['apns-push-type']).toBe('alert');
      expect(headers['content-type']).toBe('application/json');

      const body = JSON.parse(reqInit.body as string) as { aps: { alert?: { title?: string; body?: string } } };
      expect(body.aps.alert).toEqual({ title: 'Hello', body: 'World' });

      // Canonical result shape.
      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'apns-msg-1',
        raw: {},
      });
    });

    it('stateless default: every .send() triggers a fresh signing (no hidden caching)', async () => {
      mockFetch
        .mockResolvedValueOnce(apnsSuccessResponse('m1'))
        .mockResolvedValueOnce(apnsSuccessResponse('m2'));

      const connector = new ApnsPushConnector(buildConfig());
      await connector.send({ to: 'd1', title: 'a', body: 'b' });
      await connector.send({ to: 'd2', title: 'a', body: 'b' });

      // Both fetches dispatched (one per call). JWTs are signed independently — verify
      // each Authorization header is well-formed `bearer <jwt>`.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const headers1 = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      const headers2 = (mockFetch.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
      expect(headers1.authorization).toMatch(/^bearer eyJ/);
      expect(headers2.authorization).toMatch(/^bearer eyJ/);
    });

    // -------------------------------------------------------------------------
    // Production-vs-sandbox endpoint
    // -------------------------------------------------------------------------

    it('env: production → request URL contains api.push.apple.com', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig({ env: 'production' }));
      await connector.send({ to: 'd', title: 'h', body: 'w' });

      expect(mockFetch.mock.calls[0]![0]).toMatch(/^https:\/\/api\.push\.apple\.com\//);
    });

    it('env: sandbox → request URL contains api.sandbox.push.apple.com', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig({ env: 'sandbox' }));
      await connector.send({ to: 'd', title: 'h', body: 'w' });

      expect(mockFetch.mock.calls[0]![0]).toMatch(/^https:\/\/api\.sandbox\.push\.apple\.com\//);
    });

    // -------------------------------------------------------------------------
    // Header construction
    // -------------------------------------------------------------------------

    it('input.ttl=3600 → apns-expiration header set to now+3600 (±1)', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig());
      const before = Math.floor(Date.now() / 1000);
      await connector.send({ to: 'd', title: 'h', body: 'w', ttl: 3600 });

      const headers = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      const expHeader = Number(headers['apns-expiration']);
      expect(expHeader).toBeGreaterThanOrEqual(before + 3600);
      expect(expHeader).toBeLessThanOrEqual(before + 3600 + 1);
    });

    it('input.apnsTopic overrides config.bundleId in apns-topic header', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig());
      await connector.send({
        to: 'd',
        title: 'h',
        body: 'w',
        apnsTopic: 'com.example.app.voip',
      });

      const headers = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers['apns-topic']).toBe('com.example.app.voip');
    });

    it('apns-push-type defaults to "background" when no title/body present', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig());
      await connector.send({ to: 'd', data: { silent: true } });

      const headers = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers['apns-push-type']).toBe('background');
    });

    it('input.apnsPriority + apnsCollapseId emitted as headers when set', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig());
      await connector.send({
        to: 'd',
        title: 'h',
        body: 'w',
        apnsPriority: 5,
        apnsCollapseId: 'order-123',
      });

      const headers = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers['apns-priority']).toBe('5');
      expect(headers['apns-collapse-id']).toBe('order-123');
    });

    // -------------------------------------------------------------------------
    // Body construction
    // -------------------------------------------------------------------------

    it('merges input.aps kebab-case keys verbatim into the aps payload', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig());
      await connector.send({
        to: 'd',
        title: 'h',
        body: 'w',
        aps: {
          'thread-id': 'order-thread',
          category: 'ORDER_UPDATE',
          'content-available': 1,
          'mutable-content': 1,
          'interruption-level': 'time-sensitive',
        },
      });

      const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
        aps: Record<string, unknown>;
      };
      expect(body.aps['thread-id']).toBe('order-thread');
      expect(body.aps.category).toBe('ORDER_UPDATE');
      expect(body.aps['content-available']).toBe(1);
      expect(body.aps['mutable-content']).toBe(1);
      expect(body.aps['interruption-level']).toBe('time-sensitive');
    });

    it('merges custom data at the root of the payload (alongside aps)', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig());
      await connector.send({
        to: 'd',
        title: 'h',
        body: 'w',
        data: { orderId: '12345', urgent: true },
      });

      const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.orderId).toBe('12345');
      expect(body.urgent).toBe(true);
      // aps still present.
      expect(body.aps).toBeDefined();
    });

    it('merges _passthrough.body deeply into the request body', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

      const connector = new ApnsPushConnector(buildConfig());
      await connector.send({
        to: 'd',
        title: 'h',
        body: 'w',
        _passthrough: {
          body: { aps: { sound: 'siren.caf' }, customRoot: 'value' },
          headers: { 'X-Custom': 'v' },
        },
      });

      const reqInit = mockFetch.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(reqInit.body as string) as {
        aps: { alert?: unknown; sound?: string };
        customRoot?: string;
      };
      expect(body.aps.sound).toBe('siren.caf');
      expect(body.aps.alert).toEqual({ title: 'h', body: 'w' });
      expect(body.customRoot).toBe('value');

      const headers = reqInit.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('v');
    });

    // -------------------------------------------------------------------------
    // Token-cache hook paths
    // -------------------------------------------------------------------------

    describe('tokenCache hook integration', () => {
      it('cache-miss: hook.get returns null → signs fresh, calls hook.set with epoch-ms expiresAt', async () => {
        const hook = createTokenCacheMock();
        mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

        const before = Date.now();
        const connector = new ApnsPushConnector(buildConfig({ tokenCache: hook }));
        await connector.send({ to: 'd', title: 'h', body: 'w' });
        const after = Date.now();

        expect(hook.getSpy).toHaveBeenCalledTimes(1);
        expect(hook.setSpy).toHaveBeenCalledTimes(1);

        const stored = hook.store.get(CACHE_KEY);
        expect(stored).toBeDefined();
        expect(stored!.token).toMatch(/^eyJ/); // base64url-encoded JWT header
        // expiresAt is ~Date.now() + 50 * 60 * 1000.
        expect(stored!.expiresAt).toBeGreaterThanOrEqual(before + 50 * 60 * 1000);
        expect(stored!.expiresAt).toBeLessThanOrEqual(after + 50 * 60 * 1000);
      });

      it('cache-hit: hook.get returns unexpired entry → reuses, signFreshJwt NOT invoked, hook.set NOT called', async () => {
        // Seed cache via constructor so setSpy starts at 0 (explicit key).
        const hook = createTokenCacheMock({
          [CACHE_KEY]: {
            token: 'cached.jwt.value',
            expiresAt: Date.now() + 60_000,
          },
        });

        mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

        const connector = new ApnsPushConnector(buildConfig({ tokenCache: hook }));
        await connector.send({ to: 'd', title: 'h', body: 'w' });

        // Authorization used the cached JWT verbatim (not a freshly-signed one).
        const headers = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
        expect(headers.authorization).toBe('bearer cached.jwt.value');

        expect(hook.getSpy).toHaveBeenCalledTimes(1);
        expect(hook.setSpy).not.toHaveBeenCalled();
      });

      it('cache-stale: hook.get returns expired entry → treats as miss, signs fresh, calls hook.set', async () => {
        const hook = createTokenCacheMock({
          [CACHE_KEY]: {
            token: 'old.jwt.value',
            expiresAt: Date.now() - 1,
          },
        });

        mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

        const connector = new ApnsPushConnector(buildConfig({ tokenCache: hook }));
        await connector.send({ to: 'd', title: 'h', body: 'w' });

        // hook.set called once (for the fresh JWT; constructor seed bypassed the spy).
        expect(hook.setSpy).toHaveBeenCalledTimes(1);

        const stored = hook.store.get(CACHE_KEY)!;
        // The stale value was replaced with a freshly-signed JWT.
        expect(stored.token).not.toBe('old.jwt.value');
        expect(stored.token).toMatch(/^eyJ/);

        // The send used the fresh JWT in Authorization.
        const headers = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
        expect(headers.authorization).toBe(`bearer ${stored.token}`);
      });

      it('cache key is exactly "apns:<teamId>:<keyId>:<bundleId>" — fully deterministic', async () => {
        const hook = createTokenCacheMock();

        mockFetch.mockResolvedValueOnce(apnsSuccessResponse());

        const connector = new ApnsPushConnector(buildConfig({ tokenCache: hook }));
        await connector.send({ to: 'd', title: 'h', body: 'w' });

        expect(hook.getSpy).toHaveBeenCalledWith(CACHE_KEY);
      });

      it('vendor rejects cached JWT (403 InvalidProviderToken): throws auth_failed; hook NOT evicted', async () => {
        const hook = createTokenCacheMock({
          [CACHE_KEY]: {
            token: 'stale.but.not.expired',
            expiresAt: Date.now() + 60_000,
          },
        });
        const setCallsBefore = hook.setSpy.mock.calls.length;

        mockFetch.mockResolvedValueOnce(
          apnsErrorResponse(403, { reason: 'InvalidProviderToken' }),
        );

        const connector = new ApnsPushConnector(buildConfig({ tokenCache: hook }));
        await expect(
          connector.send({ to: 'd', title: 'h', body: 'w' }),
        ).rejects.toMatchObject({
          name: 'ConnectorError',
          providerCode: 'auth_failed',
          providerMessage: 'InvalidProviderToken',
          statusCode: 403,
        });

        // Wrapper did NOT call hook.set on auth-fail (consumer-owned eviction).
        expect(hook.setSpy.mock.calls.length).toBe(setCallsBefore);
        // Entry remains intact in the consumer's cache.
        expect(hook.store.get(CACHE_KEY)?.token).toBe('stale.but.not.expired');
      });
    });

    // -------------------------------------------------------------------------
    // Error mapping
    // -------------------------------------------------------------------------

    describe('error mapping', () => {
      it.each<[number, string, string]>([
        [400, 'BadDeviceToken', 'invalid_recipient'],
        [400, 'PayloadTooLarge', 'invalid_request'],
        [400, 'BadTopic', 'invalid_request'],
        [400, 'TopicDisallowed', 'invalid_request'],
        [403, 'BadDeviceToken', 'invalid_recipient'],
        [403, 'InvalidProviderToken', 'auth_failed'],
        [403, 'MissingProviderToken', 'auth_failed'],
        [403, 'ExpiredProviderToken', 'auth_failed'],
        [410, 'Unregistered', 'invalid_recipient'],
        [413, 'PayloadTooLarge', 'invalid_request'],
        [429, 'TooManyRequests', 'rate_limited'],
        [500, 'InternalServerError', 'provider_unavailable'],
        [503, 'ServiceUnavailable', 'provider_unavailable'],
        [503, 'Shutdown', 'provider_unavailable'],
      ])(
        'maps HTTP %i + reason=%s → providerCode=%s',
        async (status, reason, expectedCode) => {
          mockFetch.mockResolvedValueOnce(apnsErrorResponse(status, { reason }));

          const connector = new ApnsPushConnector(buildConfig());
          try {
            await connector.send({ to: 'd', title: 't', body: 'b' });
            expect.unreachable('Should have thrown');
          } catch (err) {
            expect(err).toBeInstanceOf(ConnectorError);
            const e = err as ConnectorError;
            expect(e.statusCode).toBe(status);
            expect(e.providerCode).toBe(expectedCode);
            expect(e.providerMessage).toContain(reason);
          }
        },
      );

      it('maps an unrecognized status (e.g. 418) to unknown', async () => {
        mockFetch.mockResolvedValueOnce(apnsErrorResponse(418, { reason: 'Teapot' }));

        const connector = new ApnsPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          const e = err as ConnectorError;
          expect(e.statusCode).toBe(418);
          expect(e.providerCode).toBe('unknown');
        }
      });

      it('handles error response with empty body (no reason field)', async () => {
        mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

        const connector = new ApnsPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          const e = err as ConnectorError;
          expect(e.statusCode).toBe(500);
          expect(e.providerCode).toBe('provider_unavailable');
          expect(e.providerMessage).toContain('APNs HTTP 500');
        }
      });

      it('wraps network errors as provider_unavailable with statusCode=null', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));

        const connector = new ApnsPushConnector(buildConfig());
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
        mockFetch.mockResolvedValueOnce(
          createRetryAfterFixture({
            status: 429,
            retryAfter: '30',
            errorBody: { reason: 'TooManyRequests' },
          }),
        );

        const connector = new ApnsPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          const e = err as ConnectorError;
          expect(e.providerCode).toBe('rate_limited');
          expect(e.providerMessage).toBe('TooManyRequests');
          expect(e.cause as Record<string, unknown>).toMatchObject({
            retryAfter: '30',
            retryAfterSeconds: 30,
          });
        }
      });

      it('does not append Retry-After text when header is absent (APNs often omits)', async () => {
        mockFetch.mockResolvedValueOnce(
          createRetryAfterFixture({
            status: 429,
            errorBody: { reason: 'TooManyRequests' },
          }),
        );

        const connector = new ApnsPushConnector(buildConfig());
        try {
          await connector.send({ to: 'd', title: 't', body: 'b' });
          expect.unreachable();
        } catch (err) {
          const e = err as ConnectorError;
          expect(e.providerMessage).toBe('TooManyRequests');
          expect((e.cause as Record<string, unknown>).retryAfter).toBeUndefined();
        }
      });
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    const defaultOptions: IPushOptions = {
      target: ['device-token-abc'],
      title: 'Test Title',
      content: 'Test Body',
      payload: { key1: 'value1' },
      subscriber: {},
      step: { digest: false, events: undefined, total_count: undefined },
    };

    it('signs a fresh JWT and POSTs the APNs message (production env)', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse('apns-uuid-123'));

      const connector = new ApnsPushConnector(buildConfig({ env: 'production' }));
      const result = await connector.sendMessage({ ...defaultOptions });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toMatch(/^https:\/\/api\.push\.apple\.com\/3\/device\/device-token-abc$/);

      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe('POST');
      const headers = reqInit.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^bearer eyJ/);
      expect(headers['apns-topic']).toBe('com.example.app');
      expect(headers['apns-push-type']).toBe('alert');

      const body = JSON.parse(reqInit.body as string) as {
        aps: { alert?: { title?: string; body?: string } };
      };
      expect(body.aps.alert).toEqual({ title: 'Test Title', body: 'Test Body' });

      expect(result).toEqual({
        ids: ['apns-uuid-123'],
        date: expect.any(String),
      });
    });

    it('uses sandbox host when env is "sandbox"', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse('sandbox-id'));

      const connector = new ApnsPushConnector(buildConfig({ env: 'sandbox' }));
      await connector.sendMessage({ ...defaultOptions });

      expect(mockFetch.mock.calls[0]![0]).toMatch(/^https:\/\/api\.sandbox\.push\.apple\.com\//);
    });

    it('sends one POST per target token for multi-recipient sends', async () => {
      mockFetch
        .mockResolvedValueOnce(apnsSuccessResponse('id-1'))
        .mockResolvedValueOnce(apnsSuccessResponse('id-2'));

      const connector = new ApnsPushConnector(buildConfig({ env: 'production' }));
      const result = await connector.sendMessage({
        ...defaultOptions,
        target: ['token-a', 'token-b'],
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.ids).toEqual(expect.arrayContaining(['id-1', 'id-2']));
      expect(result.ids).toHaveLength(2);
    });

    it('handles partial failure without throwing', async () => {
      mockFetch
        .mockResolvedValueOnce(apnsSuccessResponse('id-ok'))
        .mockResolvedValueOnce(apnsErrorResponse(410, { reason: 'Unregistered' }));

      const connector = new ApnsPushConnector(buildConfig({ env: 'production' }));
      const result = await connector.sendMessage({
        ...defaultOptions,
        target: ['token-ok', 'token-bad'],
      });

      expect(result.ids).toHaveLength(2);
      expect(result.ids).toContain('id-ok');
      expect(result.ids).toContain('Unregistered');
    });

    it('throws ConnectorError when all targets fail', async () => {
      mockFetch.mockResolvedValueOnce(apnsErrorResponse(400, { reason: 'BadDeviceToken' }));

      const connector = new ApnsPushConnector(buildConfig({ env: 'production' }));
      try {
        await connector.sendMessage({ ...defaultOptions });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.message).toBe('All 1 APNs message(s) failed to send');
        expect(e.providerMessage).toContain('BadDeviceToken');
      }
    });

    it('includes custom payload data in the APNs body', async () => {
      mockFetch.mockResolvedValueOnce(apnsSuccessResponse('id-1'));

      const connector = new ApnsPushConnector(buildConfig({ env: 'production' }));
      await connector.sendMessage({
        ...defaultOptions,
        payload: { orderId: '12345', type: 'order_update' },
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.orderId).toBe('12345');
      expect(body.type).toBe('order_update');
    });
  });
});
