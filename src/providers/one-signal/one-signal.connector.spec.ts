import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { OneSignalPushConnector } from './one-signal.connector';
import type { OneSignalConfig } from './one-signal.config';
import type { OneSignalNarrowedInput } from './one-signal.types';
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

const defaultConfig: OneSignalConfig = {
  appId: 'app-uuid-123',
  apiKey: 'rest-api-key',
};

const defaultPushOptions = {
  target: ['sub-id-1'],
  title: 'Test Title',
  content: 'Test Content',
  payload: { key: 'value' },
  subscriber: {},
  step: { digest: false, events: undefined, total_count: undefined },
};

const ONE_SIGNAL_URL = 'https://onesignal.com/api/v1/notifications';

function jsonResponse(
  body: Record<string, unknown>,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function successResponse() {
  return new Response(
    JSON.stringify({ id: 'onesignal-notif-123', external_id: null }),
    { status: 200 }
  );
}

describe('OneSignalPushConnector', () => {
  let connector: OneSignalPushConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new OneSignalPushConnector(defaultConfig);
  });

  // ===========================================================================
  // Identity
  // ===========================================================================

  it('should have id "one-signal" and channelType PUSH', () => {
    expect(connector.id).toBe('one-signal');
    expect(connector.channelType).toBe(ChannelTypeEnum.PUSH);
  });

  // ===========================================================================
  // Thinwrap-native.send()
  // ===========================================================================

  describe('.send()', () => {
    const baseInput: OneSignalNarrowedInput = {
      to: 'sub-1',
      title: 'hi',
      body: 'world',
    };

    it('happy path: HTTP 200 with id returns providerMessageId; Basic auth header present', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'notif-1', recipients: 1 }),
      );

      const result = await connector.send(baseInput);

      expect(result).toMatchObject({
        success: true,
        status: 'sent',
        providerMessageId: 'notif-1',
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(ONE_SIGNAL_URL);
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Basic rest-api-key');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('default recipient routing: input.to -> include_subscription_ids', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'n', recipients: 1 }),
      );

      await connector.send({ to: 'sub-abc', title: 'h', body: 'b' });

      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.include_subscription_ids).toEqual(['sub-abc']);
      expect(body.include_external_user_ids).toBeUndefined();
      expect(body.app_id).toBe('app-uuid-123');
      expect(body.headings).toEqual({ en: 'h' });
      expect(body.contents).toEqual({ en: 'b' });
    });

    it('augmentation override: include_external_user_ids wins; include_subscription_ids omitted', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'n', recipients: 2 }),
      );

      await connector.send({
        to: 'sub-abc',
        title: 'h',
        body: 'b',
        include_external_user_ids: ['user-1', 'user-2'],
      });

      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.include_external_user_ids).toEqual(['user-1', 'user-2']);
      expect(body.include_subscription_ids).toBeUndefined();
    });

    it('augmentation override: include_player_ids wins; include_subscription_ids omitted', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'n', recipients: 1 }),
      );

      await connector.send({
        to: 'sub-abc',
        title: 'h',
        body: 'b',
        include_player_ids: ['player-1'],
      });

      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.include_player_ids).toEqual(['player-1']);
      expect(body.include_subscription_ids).toBeUndefined();
    });

    it('200 with errors: "All included players are not subscribed" -> invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'n',
          errors: ['All included players are not subscribed'],
        }),
      );

      await expect(connector.send(baseInput)).rejects.toMatchObject({
        providerCode: 'invalid_recipient',
      });
    });

    it('200 with errors object: invalid_external_user_ids -> invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'n',
          errors: { invalid_external_user_ids: ['nope-1'] },
        }),
      );

      await expect(connector.send(baseInput)).rejects.toMatchObject({
        providerCode: 'invalid_recipient',
      });
    });

    it('HTTP 401 -> auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ errors: ['Invalid REST API key'] }, { status: 401 }),
      );

      await expect(connector.send(baseInput)).rejects.toMatchObject({
        providerCode: 'auth_failed',
        statusCode: 401,
      });
    });

    it('HTTP 400 -> invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ errors: ['bad request'] }, { status: 400 }),
      );

      await expect(connector.send(baseInput)).rejects.toMatchObject({
        providerCode: 'invalid_request',
      });
    });

    it('HTTP 404 -> invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ errors: ['app not found'] }, { status: 404 }),
      );

      await expect(connector.send(baseInput)).rejects.toMatchObject({
        providerCode: 'invalid_request',
      });
    });

    it('HTTP 503 -> provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ errors: ['upstream'] }, { status: 503 }),
      );

      await expect(connector.send(baseInput)).rejects.toMatchObject({
        providerCode: 'provider_unavailable',
      });
    });

    it('HTTP 429 with Retry-After -> rate_limited; cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '30',
          errorBody: { errors: ['rate limited'] },
        }),
      );

      try {
        await connector.send(baseInput);
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as ConnectorError & {
          cause?: { retryAfter?: string | null; retryAfterSeconds?: number };
        };
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('rate limited');
        expect(e.cause).toMatchObject({
          retryAfter: '30',
          retryAfterSeconds: 30,
        });
      }
    });

    it('network error -> ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network down'));

      try {
        await connector.send(baseInput);
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.statusCode).toBeNull();
      }
    });

    it('missing id on 200 -> invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ recipients: 0 }));

      await expect(connector.send(baseInput)).rejects.toMatchObject({
        providerCode: 'invalid_request',
      });
    });

    it('augmentation headings/contents override base title/body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'n' }));

      await connector.send({
        to: 'sub-1',
        title: 'ignored',
        body: 'ignored',
        headings: { en: 'Hello', es: 'Hola' },
        contents: { en: 'World', es: 'Mundo' },
      });

      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.headings).toEqual({ en: 'Hello', es: 'Hola' });
      expect(body.contents).toEqual({ en: 'World', es: 'Mundo' });
    });

    it('_passthrough merges into body, headers, and query', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'n' }));

      await connector.send({
        to: 'sub-1',
        title: 'h',
        body: 'b',
        _passthrough: {
          body: { custom_field: 'value' },
          headers: { 'X-Custom': 'yes' },
          query: { dryRun: 'true' },
        },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      expect(url).toBe(`${ONE_SIGNAL_URL}?dryRun=true`);
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.custom_field).toBe('value');
      const headers = reqInit.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('yes');
    });
  });

  // ===========================================================================
  // Brownfield.sendMessage() — preserved for Novu wrapper
  // ===========================================================================

  describe('.sendMessage() (brownfield)', () => {
    it('sends JSON message with Basic auth (same Authorization on both surfaces) and returns { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage(defaultPushOptions);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://onesignal.com/api/v1/notifications');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          // both surfaces use the same Authorization: Basic header.
          Authorization: 'Basic rest-api-key',
        })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.app_id).toBe('app-uuid-123');
      expect(body.contents).toEqual({ en: 'Test Content' });
      expect(body.headings).toEqual({ en: 'Test Title' });
      expect(body.include_subscription_ids).toEqual(['sub-id-1']);
      expect(body.data).toEqual({ key: 'value' });

      expect(result).toEqual({
        id: 'onesignal-notif-123',
        date: expect.any(String),
      });
    });

    it('throws ConnectorError when response has empty id (soft failure)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: '',
            errors: ['All included players are not subscribed'],
          }),
          { status: 200 }
        )
      );

      try {
        await connector.sendMessage(defaultPushOptions);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(400);
        expect(connectorErr.message).toBe(
          'All included players are not subscribed',
        );
      }
    });

    it('throws ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ['Invalid API key'] }), {
          status: 401,
        })
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
        expect(connectorErr.providerMessage).toBe('Invalid API key');
      }
    });

    it('uses overrides for title and body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        ...defaultPushOptions,
        overrides: { title: 'Override Title', body: 'Override Body' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.contents).toEqual({ en: 'Override Body' });
      expect(body.headings).toEqual({ en: 'Override Title' });
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
});
