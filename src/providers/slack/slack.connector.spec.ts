import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { SlackChatConnector } from './slack.connector';
import type { SlackConfig } from './slack.config';
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

const defaultConfig: SlackConfig = {
  webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
};

function okTextResponse() {
  return new Response('ok', { status: 200 });
}

describe('SlackChatConnector', () => {
  let connector: SlackChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new SlackChatConnector(defaultConfig);
  });

  it('should have id "slack" and channelType CHAT', () => {
    expect(connector.id).toBe('slack');
    expect(connector.channelType).toBe(ChannelTypeEnum.CHAT);
  });

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped sendMessage() surface
  // ---------------------------------------------------------------------------

  describe('sendMessage (brownfield Novu-shaped surface)', () => {
    it('should send a message to the config webhook URL', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      const result = await connector.sendMessage({
        content: 'Hello from Slack!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://hooks.slack.com/services/T00/B00/xxx');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.text).toBe('Hello from Slack!');

      expect(result).toEqual({ id: undefined, date: expect.any(String) });
    });

    it('should use options.webhookUrl over config.webhookUrl', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.sendMessage({
        content: 'Hello!',
        webhookUrl: 'https://hooks.slack.com/services/T01/B01/yyy',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://hooks.slack.com/services/T01/B01/yyy');
    });

    it('should merge bridgeProviderData passthrough body (blocks)', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.sendMessage(
        { content: 'Hello!' },
        {
          _passthrough: {
            body: {
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: '*Bold*' } },
              ],
            },
          },
        }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.blocks).toBeDefined();
      expect(body.text).toBe('Hello!');
    });

    it('should throw ConnectorError when no webhook URL is provided', async () => {
      const noUrlConnector = new SlackChatConnector({});

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
        new Response('invalid_token', { status: 403 })
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
        expect(connectorErr.providerMessage).toBe('invalid_token');
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
    it('happy path: HTTP 200 with plain text "ok" body', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      const result = await connector.send({ body: 'Hello from Slack!' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://hooks.slack.com/services/T00/B00/xxx');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(wireBody.text).toBe('Hello from Slack!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: null,
        raw: 'ok',
      });
    });

    it('maps all narrowed fields to snake_case wire keys', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.send({
        body: 'hi',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }],
        attachments: [{ color: 'good', text: 'attached' }],
        username: 'alertbot',
        iconEmoji: ':robot_face:',
        iconUrl: 'https://x/y.png',
        threadTs: '1234.5678',
        mrkdwn: true,
        unfurlLinks: false,
        unfurlMedia: false,
        linkNames: true,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const wireBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      expect(wireBody.text).toBe('hi');
      expect(wireBody.blocks).toEqual([
        { type: 'section', text: { type: 'mrkdwn', text: 'hi' } },
      ]);
      expect(wireBody.attachments).toEqual([{ color: 'good', text: 'attached' }]);
      expect(wireBody.username).toBe('alertbot');
      expect(wireBody.icon_emoji).toBe(':robot_face:');
      expect(wireBody.icon_url).toBe('https://x/y.png');
      expect(wireBody.thread_ts).toBe('1234.5678');
      expect(wireBody.mrkdwn).toBe(true);
      expect(wireBody.unfurl_links).toBe(false);
      expect(wireBody.unfurl_media).toBe(false);
      expect(wireBody.link_names).toBe(true);

      // Verify camelCase keys are NOT leaked to the wire.
      expect(wireBody.iconEmoji).toBeUndefined();
      expect(wireBody.iconUrl).toBeUndefined();
      expect(wireBody.threadTs).toBeUndefined();
      expect(wireBody.unfurlLinks).toBeUndefined();
      expect(wireBody.unfurlMedia).toBeUndefined();
      expect(wireBody.linkNames).toBeUndefined();
    });

    it('404 (deleted webhook) → auth_failed with no_service body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('no_service', { status: 404 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.statusCode).toBe(404);
        expect(ce.providerMessage).toBe('no_service');
      }
    });

    it('403 (revoked webhook) → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(new Response('invalid_token', { status: 403 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.statusCode).toBe(403);
      }
    });

    it('401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('auth_failed');
      }
    });

    it('400 → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(new Response('invalid_payload', { status: 400 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.providerMessage).toBe('invalid_payload');
      }
    });

    it('500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('provider_unavailable');
      }
    });

    it('429 + Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: 'rate_limited',
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
        expect(ce.statusCode).toBe(429);
        expect(ce.providerMessage).toBe('rate_limited');
        expect(ce.cause).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('_passthrough body and headers merge correctly', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.send({
        body: 'hi',
        _passthrough: {
          body: { metadata: { event_type: 'incident', event_payload: { sev: 'p1' } } },
          headers: { 'X-Trace-Id': 't-1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;

      expect(wireBody.text).toBe('hi');
      expect(wireBody.metadata).toEqual({
        event_type: 'incident',
        event_payload: { sev: 'p1' },
      });

      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Trace-Id': 't-1',
        })
      );

      // Compile-time contract: `to` is NOT a field on SlackNarrowedInput.
      // @ts-expect-error - 'to' is omitted from SlackNarrowedInput (webhook URL targets the channel).
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
      const noUrlConnector = new SlackChatConnector({});

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
