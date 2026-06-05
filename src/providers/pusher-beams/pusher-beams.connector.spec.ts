import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { PusherBeamsPushConnector } from './pusher-beams.connector';
import type { PusherBeamsConfig } from './pusher-beams.config';
import type { PusherBeamsPushSendInput } from './pusher-beams.types';
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

const defaultConfig: PusherBeamsConfig = {
  instanceId: 'instance-abc',
  secretKey: 'secret-xyz',
};

const USERS_URL =
  'https://instance-abc.pushnotifications.pusher.com/publish_api/v1/instances/instance-abc/publishes/users';
const INTERESTS_URL =
  'https://instance-abc.pushnotifications.pusher.com/publish_api/v1/instances/instance-abc/publishes/interests';

function successResponse(publishId = 'publish-123') {
  return new Response(JSON.stringify({ publishId }), { status: 200 });
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('PusherBeamsPushConnector', () => {
  let connector: PusherBeamsPushConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new PusherBeamsPushConnector(defaultConfig);
  });

  // ---------------------------------------------------------------------------
  // Brownfield surface (preserved wrap target)
  // ---------------------------------------------------------------------------

  describe('brownfield sendMessage()', () => {
    const defaultPushOptions = {
      target: ['target-1'],
      title: 'Test Title',
      content: 'Test Content',
      payload: {},
      subscriber: {},
      step: { digest: false, events: undefined, total_count: undefined },
    };

    it('has id "pusher-beams" and channelType PUSH', () => {
      expect(connector.id).toBe('pusher-beams');
      expect(connector.channelType).toBe(ChannelTypeEnum.PUSH);
    });

    it('sends JSON with Bearer auth and returns { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(successResponse('publish-123'));

      const result = await connector.sendMessage(defaultPushOptions);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(USERS_URL);
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-xyz',
        })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.users).toEqual(['target-1']);
      expect(body.fcm).toEqual({ notification: { title: 'Test Title', body: 'Test Content' } });
      expect(body.apns).toEqual({ aps: { alert: { title: 'Test Title', body: 'Test Content' } } });
      expect(body.web).toEqual({ notification: { title: 'Test Title', body: 'Test Content' } });

      expect(result).toEqual({ id: 'publish-123', date: expect.any(String) });
    });

    it('throws ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      );

      try {
        await connector.sendMessage(defaultPushOptions);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(401);
        // Brownfield now routes through canonical mapVendorError
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Unauthorized');
      }
    });

    it('throws ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage(defaultPushOptions);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network failure');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Thinwrap-native send() outlier synthesis (critical path)
  // ---------------------------------------------------------------------------

  describe('send() wire synthesis', () => {
    it('synthesizes fcm + apns + web payloads from base PushSendInput', async () => {
      mockFetch.mockResolvedValueOnce(successResponse('pub-1'));

      const beforeEpoch = Math.floor(Date.now() / 1000);
      await connector.send({
        to: 'user-1',
        title: 'Hello',
        body: 'World',
        badge: 3,
        sound: 'default',
        data: { itemId: 42, urgent: true },
        ttl: 3600,
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      expect(url).toBe(USERS_URL);
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-xyz',
        })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;

      expect(body.users).toEqual(['user-1']);

      // FCM payload — Beams nests under `fcm`. Data values must be strings.
      expect(body.fcm).toMatchObject({
        notification: { title: 'Hello', body: 'World' },
        android: { ttl: '3600s' },
      });
      expect((body.fcm as Record<string, unknown>).data).toEqual({
        itemId: '42',
        urgent: 'true',
      });

      // APNs payload — Beams nests under `apns`.
      expect(body.apns).toMatchObject({
        aps: {
          alert: { title: 'Hello', body: 'World' },
          badge: 3,
          sound: 'default',
        },
      });
      const apnsExp = (body.apns as Record<string, unknown>)['apns-expiration'] as number;
      expect(apnsExp).toBeGreaterThanOrEqual(beforeEpoch + 3600);
      expect(apnsExp).toBeLessThanOrEqual(beforeEpoch + 3600 + 1);

      // Web preserves original `data` types (no string-coercion).
      expect(body.web).toMatchObject({
        notification: { title: 'Hello', body: 'World' },
        data: { itemId: 42, urgent: true },
      });
    });

    it('routes interests broadcasts to /publishes/interests', async () => {
      mockFetch.mockResolvedValueOnce(successResponse('pub-2'));

      const input: PusherBeamsPushSendInput = {
        to: 'unused',
        title: 'h',
        body: 'b',
        interests: ['news', 'sports'],
      };
      await connector.send(input);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(INTERESTS_URL);
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.interests).toEqual(['news', 'sports']);
      expect(body.users).toBeUndefined();
    });

    it('uses input.users array over input.to', async () => {
      mockFetch.mockResolvedValueOnce(successResponse('pub-3'));

      const input: PusherBeamsPushSendInput = {
        to: 'ignored',
        title: 'h',
        body: 'b',
        users: ['u1', 'u2', 'u3'],
      };
      await connector.send(input);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(USERS_URL);
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.users).toEqual(['u1', 'u2', 'u3']);
    });

    it('merges apns augmentation into synthesized aps fields', async () => {
      mockFetch.mockResolvedValueOnce(successResponse('pub-4'));

      const input: PusherBeamsPushSendInput = {
        to: 'u1',
        title: 'h',
        body: 'b',
        apns: { aps: { 'thread-id': 'chat-1', category: 'MESSAGE' } },
      };
      await connector.send(input);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      const aps = (body.apns as Record<string, unknown>).aps as Record<string, unknown>;
      expect(aps['thread-id']).toBe('chat-1');
      expect(aps.category).toBe('MESSAGE');
      // Synthesized aps.alert must survive the augmentation merge.
      expect(aps.alert).toEqual({ title: 'h', body: 'b' });
    });

    it('coerces non-string FCM data values to strings', async () => {
      mockFetch.mockResolvedValueOnce(successResponse('pub-data'));

      await connector.send({
        to: 'u1',
        title: 'h',
        body: 'b',
        data: { count: 5, flag: true, obj: { nested: 'yes' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect((body.fcm as Record<string, unknown>).data).toEqual({
        count: '5',
        flag: 'true',
        obj: '{"nested":"yes"}',
      });
    });

    it('happy path returns providerMessageId from response body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse('pub-5'));

      const result = await connector.send({ to: 'u1', title: 'h', body: 'b' });

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'pub-5',
        raw: { publishId: 'pub-5' },
      });
    });

    it('maps HTTP 401 to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401, { error: 'Unauthorized' }));

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.statusCode).toBe(401);
        expect(ce.providerMessage).toBe('Unauthorized');
      }
    });

    it('maps HTTP 422 to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(422, { error: 'No subscribers' }));

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_recipient');
        expect(ce.statusCode).toBe(422);
      }
    });

    it('maps HTTP 429 with Retry-After to rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '30',
          errorBody: { error: 'Too many requests' },
        }),
      );

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('rate_limited');
        expect(ce.providerMessage).toBe('Too many requests');
        const cause = ce.cause as { raw: unknown; retryAfter: string; retryAfterSeconds: number };
        expect(cause.retryAfter).toBe('30');
        expect(cause.retryAfterSeconds).toBe(30);
      }
    });

    it('maps HTTP 500 to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, { error: 'Internal error' }));

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('provider_unavailable');
      }
    });

    it('maps HTTP 400 to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(400, { error: 'Bad request' }));

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
      }
    });

    it('throws provider_unavailable on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.statusCode).toBeNull();
        expect(ce.providerCode).toBe('provider_unavailable');
      }
    });

    it('merges _passthrough.body via mergePassthrough', async () => {
      mockFetch.mockResolvedValueOnce(successResponse('pub-pt'));

      await connector.send({
        to: 'u1',
        title: 'h',
        body: 'b',
        _passthrough: {
          body: { custom_field: 'verbatim' } as unknown as Record<string, unknown>,
          headers: { 'X-Custom': 'pt-header' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.custom_field).toBe('verbatim');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Custom': 'pt-header' }),
      );
    });

    it('uses config.fetch when provided', async () => {
      const customFetch = vi.fn().mockResolvedValueOnce(successResponse('pub-cf'));
      const localConnector = new PusherBeamsPushConnector({
        instanceId: 'instance-abc',
        secretKey: 'secret-xyz',
        fetch: customFetch as unknown as typeof fetch,
      });

      await localConnector.send({ to: 'u1', title: 'h', body: 'b' });

      expect(customFetch).toHaveBeenCalledOnce();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
