import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { GoogleChatChatConnector } from './google-chat.connector';
import type { GoogleChatConfig } from './google-chat.config';
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

const defaultConfig: GoogleChatConfig = {
  webhookUrl:
    'https://chat.googleapis.com/v1/spaces/SPACE_ID/messages?key=KEY&token=TOKEN',
};

function successResponse() {
  return new Response(
    JSON.stringify({
      name: 'spaces/SPACE_ID/messages/MSG_ID',
      thread: { name: 'spaces/SPACE_ID/threads/THREAD_ID' },
    }),
    { status: 200 }
  );
}

describe('GoogleChatChatConnector', () => {
  let connector: GoogleChatChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new GoogleChatChatConnector(defaultConfig);
  });

  it('should have id "google-chat" and channelType CHAT', () => {
    expect(connector.id).toBe('google-chat');
    expect(connector.channelType).toBe(ChannelTypeEnum.CHAT);
  });

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped sendMessage() surface
  // ---------------------------------------------------------------------------

  describe('sendMessage (brownfield Novu-shaped surface)', () => {
    it('should send a message to the config webhook URL', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        content: 'Hello from Google Chat!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://chat.googleapis.com/v1/spaces/SPACE_ID/messages?key=KEY&token=TOKEN'
      );
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.text).toBe('Hello from Google Chat!');

      expect(result).toEqual({
        id: 'spaces/SPACE_ID/messages/MSG_ID',
        date: expect.any(String),
      });
    });

    it('should use options.webhookUrl over config.webhookUrl', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        content: 'Hello!',
        webhookUrl: 'https://chat.googleapis.com/v1/spaces/OTHER/messages?key=K2&token=T2',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://chat.googleapis.com/v1/spaces/OTHER/messages?key=K2&token=T2'
      );
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { content: 'Hello!' },
        {
          _passthrough: {
            body: { thread: { name: 'spaces/SPACE_ID/threads/THREAD_ID' } },
          },
        }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.thread).toBeDefined();
      expect(body.text).toBe('Hello!');
    });

    it('should throw ConnectorError when no webhook URL is provided', async () => {
      const noUrlConnector = new GoogleChatChatConnector({});

      try {
        await noUrlConnector.sendMessage({ content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(400);
        expect(connectorErr.message).toContain('Missing webhook URL');
      }
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'The caller does not have permission' } }),
          { status: 403 }
        )
      );

      try {
        await connector.sendMessage({ content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(403);
        // Brownfield now routes through canonical mapVendorError
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('The caller does not have permission');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({ content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network failure');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Thinwrap-native send() surface.
  // ---------------------------------------------------------------------------

  describe('send() — Thinwrap-native IChatConnector surface', () => {
    it('happy path: HTTP 200 with full JSON Message response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'spaces/AAAA/messages/BBBB.BBBB',
            sender: { name: 'spaces/AAAA/members/CCCC', type: 'BOT' },
            text: 'Hello from Google Chat!',
            thread: { name: 'spaces/AAAA/threads/TTTT' },
            createTime: '2026-05-14T12:00:00Z',
          }),
          { status: 200 },
        ),
      );

      const result = await connector.send({ body: 'Hello from Google Chat!' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://chat.googleapis.com/v1/spaces/SPACE_ID/messages?key=KEY&token=TOKEN',
      );
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json; charset=UTF-8' }),
      );

      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(wireBody.text).toBe('Hello from Google Chat!');

      expect(result.success).toBe(true);
      expect(result.status).toBe('sent');
      expect(result.providerMessageId).toBe('spaces/AAAA/messages/BBBB.BBBB');
      const raw = result.raw as { thread?: { name: string } };
      expect(raw.thread?.name).toBe('spaces/AAAA/threads/TTTT');
    });

    it('maps all narrowed fields to camelCase wire keys', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ name: 'spaces/A/messages/M' }),
          { status: 200 },
        ),
      );

      await connector.send({
        body: 'hi',
        cardsV2: [
          {
            cardId: 'c1',
            card: {
              header: { title: 'Alert' },
              sections: [{ widgets: [{ textParagraph: { text: 'details' } }] }],
            },
          },
        ],
        thread: { name: 'spaces/A/threads/T' },
        fallbackText: 'Alert summary',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const wireBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      expect(wireBody.text).toBe('hi');
      expect(wireBody.cardsV2).toEqual([
        {
          cardId: 'c1',
          card: {
            header: { title: 'Alert' },
            sections: [{ widgets: [{ textParagraph: { text: 'details' } }] }],
          },
        },
      ]);
      expect(wireBody.thread).toEqual({ name: 'spaces/A/threads/T' });
      expect(wireBody.fallbackText).toBe('Alert summary');

      // — assert camelCase keys are on the wire and snake_case is NOT.
      expect(wireBody.cards_v2).toBeUndefined();
      expect(wireBody.fallback_text).toBeUndefined();
    });

    it('401 → auth_failed (invalid key query param)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 401, message: 'UNAUTHENTICATED', status: 'UNAUTHENTICATED' } }),
          { status: 401 },
        ),
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.statusCode).toBe(401);
      }
    });

    it('404 → auth_failed (deleted webhook or space)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 404, message: 'Not found.', status: 'NOT_FOUND' } }),
          { status: 404 },
        ),
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.statusCode).toBe(404);
        expect(ce.providerMessage).toBe('Not found.');
      }
    });

    it('429 + Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { error: { code: 429, message: 'Quota exceeded.', status: 'RESOURCE_EXHAUSTED' } },
        }),
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('rate_limited');
        expect(ce.statusCode).toBe(429);
        expect(ce.providerMessage).toBe('Quota exceeded.');
        expect(ce.cause).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('400 → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 400, message: 'Invalid request.', status: 'INVALID_ARGUMENT' } }),
          { status: 400 },
        ),
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.providerMessage).toBe('Invalid request.');
      }
    });

    it('500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 500, message: 'Internal error.', status: 'INTERNAL' } }),
          { status: 500 },
        ),
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('provider_unavailable');
      }
    });

    it('_passthrough body and headers merge correctly', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ name: 'spaces/A/messages/M' }),
          { status: 200 },
        ),
      );

      await connector.send({
        body: 'hi',
        _passthrough: {
          body: { argumentText: 'slash command args' },
          headers: { 'X-Trace-Id': 't-1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;

      expect(wireBody.text).toBe('hi');
      expect(wireBody.argumentText).toBe('slash command args');

      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Trace-Id': 't-1',
        }),
      );

      // Compile-time contract: `to` is NOT a field on GoogleChatNarrowedInput.
      // @ts-expect-error - 'to' is omitted from GoogleChatNarrowedInput (webhook URL targets the space).
      void (async () => connector.send({ to: 'x', body: 'y' }));
    });

    it('network error → ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('socket hang up'));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('provider_unavailable');
        expect(ce.statusCode).toBeNull();
      }
    });

    it('missing config.webhookUrl → ConnectorError invalid_request', async () => {
      const noUrlConnector = new GoogleChatChatConnector({});

      try {
        await noUrlConnector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.statusCode).toBe(400);
      }
    });
  });
});
