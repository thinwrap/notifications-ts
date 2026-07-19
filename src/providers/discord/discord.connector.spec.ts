import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { DiscordChatConnector } from './discord.connector';
import type { DiscordConfig } from './discord.config';
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

const defaultConfig: DiscordConfig = {
  webhookUrl: 'https://discord.com/api/webhooks/123/abc',
};

function successResponse() {
  return new Response(
    JSON.stringify({
      id: '987654321',
      type: 0,
      content: 'Hello!',
      channel_id: '456',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('DiscordChatConnector', () => {
  let connector: DiscordChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new DiscordChatConnector(defaultConfig);
  });

  it('should have id "discord" and channelType CHAT', () => {
    expect(connector.id).toBe('discord');
    expect(connector.channelType).toBe(ChannelTypeEnum.CHAT);
  });

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped sendMessage() surface
  // ---------------------------------------------------------------------------

  describe('sendMessage (brownfield Novu-shaped surface)', () => {
    it('should send a message to the config webhook URL with ?wait=true', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        content: 'Hello from Discord!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://discord.com/api/webhooks/123/abc?wait=true');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.content).toBe('Hello from Discord!');

      expect(result).toEqual({ id: '987654321', date: expect.any(String) });
    });

    it('should use options.webhookUrl over config.webhookUrl', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        content: 'Hello!',
        webhookUrl: 'https://discord.com/api/webhooks/789/xyz',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://discord.com/api/webhooks/789/xyz?wait=true');
    });

    it('should merge bridgeProviderData passthrough body (embeds)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { content: 'Hello!' },
        {
          _passthrough: { body: { embeds: [{ title: 'Embed', description: 'Test' }] } },
        }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.embeds).toBeDefined();
      expect(body.content).toBe('Hello!');
    });

    it('should throw ConnectorError when no webhook URL is provided', async () => {
      const noUrlConnector = new DiscordChatConnector({});

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
        new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404 })
      );

      try {
        await connector.sendMessage({ content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(404);
        // Brownfield now routes through canonical mapVendorError
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Unknown Webhook');
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

    it('redacts the (overridden) webhook URL from surfaced error messages', async () => {
      mockFetch.mockRejectedValueOnce(
        new Error(
          'connect ECONNREFUSED https://discord.com/api/webhooks/789/secret-xyz',
        ),
      );

      try {
        await connector.sendMessage({
          content: 'hi',
          webhookUrl: 'https://discord.com/api/webhooks/789/secret-xyz',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.message).not.toContain('789/secret-xyz');
        expect(ce.message).not.toContain('secret-xyz');
        expect(ce.message).toContain('<redacted>');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Thinwrap-native send() surface.
  // ---------------------------------------------------------------------------

  describe('send() — Thinwrap-native IChatConnector surface', () => {
    it('2xx happy path: returns providerMessageId from response body; URL has ?wait=true', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({ body: 'Hello from Discord!' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      const parsed = new URL(url as string);
      expect(parsed.origin + parsed.pathname).toBe(
        'https://discord.com/api/webhooks/123/abc'
      );
      expect(parsed.searchParams.get('wait')).toBe('true');

      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(wireBody.content).toBe('Hello from Discord!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: '987654321',
        raw: expect.objectContaining({ id: '987654321', type: 0 }),
      });
    });

    it('maps all narrowed fields to snake_case wire keys', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        body: 'hi',
        embeds: [{ title: 'T', description: 'D' }],
        components: [{ type: 1, components: [{ type: 2, label: 'Click' }] }],
        username: 'alertbot',
        avatarUrl: 'https://x/y.png',
        tts: true,
        flags: 4,
        allowedMentions: { parse: ['users'] },
        threadName: 'discussion',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const wireBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      expect(wireBody.content).toBe('hi');
      expect(wireBody.embeds).toEqual([{ title: 'T', description: 'D' }]);
      expect(wireBody.components).toEqual([
        { type: 1, components: [{ type: 2, label: 'Click' }] },
      ]);
      expect(wireBody.username).toBe('alertbot');
      expect(wireBody.avatar_url).toBe('https://x/y.png');
      expect(wireBody.tts).toBe(true);
      expect(wireBody.flags).toBe(4);
      expect(wireBody.allowed_mentions).toEqual({ parse: ['users'] });
      expect(wireBody.thread_name).toBe('discussion');

      // Verify camelCase keys are NOT leaked to the wire.
      expect(wireBody.avatarUrl).toBeUndefined();
      expect(wireBody.allowedMentions).toBeUndefined();
      expect(wireBody.threadName).toBeUndefined();
      expect(wireBody.threadId).toBeUndefined();
    });

    it('threadId becomes ?thread_id query parameter (not body field)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({ body: 'hi', threadId: '111222333' });

      const [url, init] = mockFetch.mock.calls[0]!;
      const parsed = new URL(url as string);

      expect(parsed.searchParams.get('wait')).toBe('true');
      expect(parsed.searchParams.get('thread_id')).toBe('111222333');

      // Confirm threadId is NOT in the JSON body.
      const wireBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(wireBody.thread_id).toBeUndefined();
      expect(wireBody.threadId).toBeUndefined();
    });

    it('404 (deleted webhook) → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.statusCode).toBe(404);
        expect(ce.providerMessage).toBe('Unknown Webhook');
      }
    });

    it('429 + body.retry_after (seconds, float) — cause.retryAfterSeconds = ceil(seconds)', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          // No Retry-After header — Discord puts retry_after in JSON body.
          errorBody: {
            message: 'You are being rate limited.',
            retry_after: 4.2,
            global: false,
          },
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
        expect(ce.providerMessage).toBe('You are being rate limited.');
        expect(ce.cause).toMatchObject({ retryAfterSeconds: 5 });
      }
    });

    it('429 + Retry-After header (RFC 7231 seconds) — cause.retryAfter raw, cause.retryAfterSeconds parsed', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '4',
          // Empty body, as in the original fixture.
          errorBody: '',
          contentType: 'text/plain',
        }),
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('rate_limited');
        expect(ce.cause).toMatchObject({
          retryAfter: '4',
          retryAfterSeconds: 4,
        });
      }
    });

    it('_passthrough body deep-merges; `to` is not a field on the narrowed type', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        body: 'hi',
        _passthrough: {
          body: { allowed_mentions: { parse: ['everyone'], replied_user: true } },
          headers: { 'X-Trace-Id': 't-1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;

      expect(wireBody.content).toBe('hi');
      expect(wireBody.allowed_mentions).toEqual({
        parse: ['everyone'],
        replied_user: true,
      });

      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Trace-Id': 't-1',
        })
      );

      // Compile-time contract: `to` is NOT a field on DiscordNarrowedInput.
      // @ts-expect-error - 'to' is omitted from DiscordNarrowedInput (webhook URL targets the channel).
      void (async () => connector.send({ to: 'x', body: 'y' }));
    });

    it('400 → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Cannot send empty message', code: 50006 }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      try {
        await connector.send({ body: '' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.providerMessage).toBe('Cannot send empty message');
      }
    });

    it('500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('provider_unavailable');
      }
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

    it('redacts the webhook URL (the credential) from surfaced error messages', async () => {
      // Simulate an underlying fetch error that leaks the full webhook URL.
      mockFetch.mockRejectedValueOnce(
        new Error(
          'request to https://discord.com/api/webhooks/123/abc?wait=true failed',
        ),
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.message).not.toContain(
          'https://discord.com/api/webhooks/123/abc',
        );
        expect(ce.message).not.toContain('/123/abc');
        expect(ce.message).toContain('<redacted>');
      }
    });

    it('missing config.webhookUrl → ConnectorError invalid_request', async () => {
      const noUrlConnector = new DiscordChatConnector({});

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
