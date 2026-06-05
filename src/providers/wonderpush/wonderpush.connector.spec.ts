import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { WonderPushPushConnector } from './wonderpush.connector';
import type { WonderPushConfig } from './wonderpush.config';
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

const defaultConfig: WonderPushConfig = {
  accessToken: 'wp-token-xyz',
};

function successResponse(body: Record<string, unknown> = { id: 'wp-1' }) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('WonderPushPushConnector', () => {
  let connector: WonderPushPushConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new WonderPushPushConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('happy path: Bearer header + JSON body + providerMessageId from `id`', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ id: 'wp-1' }));

      const result = await connector.send({
        to: 'u1',
        title: 'hi',
        body: 'world',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      // URL is the bare endpoint, NO accessToken query param (brownfield migration).
      expect(url).toBe('https://management-api.wonderpush.com/v1/deliveries');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer wp-token-xyz',
        }),
      );

      // Body is a JSON string (not form-encoded).
      expect(typeof reqInit.body).toBe('string');
      expect(() => JSON.parse(reqInit.body as string)).not.toThrow();

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'wp-1',
        raw: expect.objectContaining({ id: 'wp-1' }),
      });
    });

    it('falls back to `notificationId` when `id` is absent in response', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({ success: true, notificationId: 'wp-fallback' }),
      );

      const result = await connector.send({
        to: 'u1',
        title: 'hi',
        body: 'world',
      });

      expect(result.providerMessageId).toBe('wp-fallback');
    });

    it('default recipient routing: input.to → targetUserIds: [input.to]', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ id: 'wp-2' }));

      await connector.send({ to: 'user-abc', title: 'h', body: 'b' });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.targetUserIds).toEqual(['user-abc']);
    });

    it('augmentation: targetUserIds array overrides default single-element wrapping', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ id: 'wp-3' }));

      await connector.send({
        to: 'ignored',
        title: 'h',
        body: 'b',
        targetUserIds: ['u1', 'u2'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.targetUserIds).toEqual(['u1', 'u2']);
    });

    it('segment routing: targetSegmentIds set in body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ id: 'wp-4' }));

      await connector.send({
        to: 'u1',
        title: 'h',
        body: 'b',
        targetSegmentIds: ['seg-1'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.targetSegmentIds).toEqual(['seg-1']);
    });

    it('notification body mapping: title/body/sound/badge/data → notification.{alert,sound,badge,custom}', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ id: 'wp-5' }));

      await connector.send({
        to: 'u1',
        title: 'T',
        body: 'B',
        sound: 's',
        badge: 3,
        data: { k: 'v' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.notification).toMatchObject({
        alert: { title: 'T', text: 'B' },
        sound: 's',
        badge: 3,
        custom: { k: 'v' },
      });
    });

    it('forwards optional applicationId from config into the request body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ id: 'wp-app' }));
      const c = new WonderPushPushConnector({
        accessToken: 'wp-token-xyz',
        applicationId: 'app-123',
      });

      await c.send({ to: 'u1', title: 'h', body: 'b' });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.applicationId).toBe('app-123');
    });

    it('_passthrough.body deep-merges into the request body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ id: 'wp-pt' }));

      await connector.send({
        to: 'u1',
        title: 'h',
        body: 'b',
        _passthrough: { body: { extraField: 'on' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.extraField).toBe('on');
    });

    it('HTTP 401 → auth_failed with providerMessage from body.error.message', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, {
          error: {
            code: 11003,
            message: 'Invalid access token',
            status: 'UNAUTHORIZED',
          },
        }),
      );

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.statusCode).toBe(401);
        expect(e.providerMessage).toContain('Invalid access token');
      }
    });

    it('HTTP 404 → invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(404, {
          error: { code: 11004, message: 'unknown user', status: 'NOT_FOUND' },
        }),
      );

      try {
        await connector.send({ to: 'u-missing', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('invalid_recipient');
      }
    });

    it('HTTP 429 with Retry-After: 30 → rate_limited; cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '30',
          errorBody: {
            error: {
              code: 429,
              message: 'rate limited',
              status: 'TOO_MANY_REQUESTS',
            },
          },
        }),
      );

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('rate limited');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '30',
          retryAfterSeconds: 30,
        });
      }
    });

    it('HTTP 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, {
          error: { code: 500, message: 'upstream', status: 'INTERNAL' },
        }),
      );

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('provider_unavailable');
      }
    });

    it('HTTP 400 → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          error: { code: 400, message: 'bad payload', status: 'BAD_REQUEST' },
        }),
      );

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('invalid_request');
      }
    });

    it('wraps fetch network errors as ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await connector.send({ to: 'u1', title: 'h', body: 'b' });
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
    const defaultPushOptions = {
      target: ['target-1'],
      title: 'Test Title',
      content: 'Test Content',
      payload: {},
      subscriber: {},
      step: { digest: false, events: undefined, total_count: undefined },
    };

    function brownfieldSuccess() {
      return new Response(
        JSON.stringify({ success: true, notificationId: 'wp-notif-123' }),
        { status: 200 },
      );
    }

    it('should have id "wonderpush" and channelType PUSH', () => {
      expect(connector.id).toBe('wonderpush');
      expect(connector.channelType).toBe(ChannelTypeEnum.PUSH);
    });

    it('should send a form-encoded message with Bearer auth header ( security) and return { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(brownfieldSuccess());

      const result = await connector.sendMessage(defaultPushOptions);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      // accessToken moved out of URL query into Authorization header.
      expect(url).toBe('https://management-api.wonderpush.com/v1/deliveries');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Bearer wp-token-xyz',
        }),
      );

      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('targetUserIds')).toBe('target-1');

      const notification = JSON.parse(params.get('notification')!);
      expect(notification).toEqual({
        alert: { title: 'Test Title', text: 'Test Content' },
      });

      expect(result).toEqual({ id: 'wp-notif-123', date: expect.any(String) });
    });

    it('should join multiple targets with commas', async () => {
      mockFetch.mockResolvedValueOnce(brownfieldSuccess());

      await connector.sendMessage({
        ...defaultPushOptions,
        target: ['user-1', 'user-2', 'user-3'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('targetUserIds')).toBe('user-1,user-2,user-3');
    });

    it('should use overrides for title and body', async () => {
      mockFetch.mockResolvedValueOnce(brownfieldSuccess());

      await connector.sendMessage({
        ...defaultPushOptions,
        overrides: { title: 'Override Title', body: 'Override Body' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      const notification = JSON.parse(params.get('notification')!);
      expect(notification).toEqual({
        alert: { title: 'Override Title', text: 'Override Body' },
      });
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(brownfieldSuccess());

      await connector.sendMessage(defaultPushOptions, {
        _passthrough: { body: { campaignId: 'campaign-123' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('campaignId')).toBe('campaign-123');
      expect(params.get('targetUserIds')).toBe('target-1');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Invalid access token' } }),
          { status: 401 },
        ),
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
        expect(connectorErr.providerMessage).toBe('Invalid access token');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
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
});
