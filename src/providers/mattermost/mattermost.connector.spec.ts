import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MattermostChatConnector } from './mattermost.connector';
import type { MattermostConfig } from './mattermost.config';
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

const defaultConfig: MattermostConfig = {
  webhookUrl: 'https://mattermost.example.com/hooks/abc123',
};

function okTextResponse() {
  return new Response('ok', { status: 200 });
}

describe('MattermostChatConnector', () => {
  let connector: MattermostChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new MattermostChatConnector(defaultConfig);
  });

  it('should have id "mattermost" and channelType CHAT', () => {
    expect(connector.id).toBe('mattermost');
    expect(connector.channelType).toBe(ChannelTypeEnum.CHAT);
  });

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped sendMessage() surface
  // ---------------------------------------------------------------------------

  describe('sendMessage (brownfield Novu-shaped surface)', () => {
    it('should send a message to the config webhook URL', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      const result = await connector.sendMessage({
        content: 'Hello from Mattermost!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://mattermost.example.com/hooks/abc123');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.text).toBe('Hello from Mattermost!');

      expect(result).toEqual({ id: undefined, date: expect.any(String) });
    });

    it('should include channel when options.channel is provided', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.sendMessage({
        content: 'Hello!',
        channel: 'town-square',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.channel).toBe('town-square');
      expect(body.text).toBe('Hello!');
    });

    it('should not include channel when options.channel is not provided', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.sendMessage({
        content: 'Hello!',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.channel).toBeUndefined();
    });

    it('should use options.webhookUrl over config.webhookUrl', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.sendMessage({
        content: 'Hello!',
        webhookUrl: 'https://mattermost.example.com/hooks/xyz789',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://mattermost.example.com/hooks/xyz789');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.sendMessage(
        { content: 'Hello!' },
        {
          _passthrough: {
            body: {
              icon_url: 'https://example.com/icon.png',
              username: 'bot',
            },
          },
        }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.icon_url).toBe('https://example.com/icon.png');
      expect(body.username).toBe('bot');
      expect(body.text).toBe('Hello!');
    });

    it('should throw ConnectorError when no webhook URL is provided', async () => {
      const noUrlConnector = new MattermostChatConnector({});

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
      mockFetch.mockResolvedValueOnce(new Response('invalid_token', { status: 403 }));

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

      const result = await connector.send({ body: 'Hello from Mattermost!' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://mattermost.example.com/hooks/abc123');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(wireBody.text).toBe('Hello from Mattermost!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: null,
        raw: 'ok',
      });
    });

    it('maps all narrowed top-level fields to snake_case wire keys', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.send({
        body: 'hi',
        username: 'alertbot',
        iconUrl: 'https://x/i.png',
        iconEmoji: ':robot_face:',
        // base ChatSendInput `to` → wire `channel`.
        to: '#alerts',
        props: { card: 'data' },
        type: 'custom_alert',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const wireBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      expect(wireBody.text).toBe('hi');
      expect(wireBody.username).toBe('alertbot');
      expect(wireBody.icon_url).toBe('https://x/i.png');
      expect(wireBody.icon_emoji).toBe(':robot_face:');
      expect(wireBody.channel).toBe('#alerts');
      expect(wireBody.props).toEqual({ card: 'data' });
      expect(wireBody.type).toBe('custom_alert');

      // Verify camelCase top-level keys are NOT leaked to the wire.
      expect(wireBody.iconUrl).toBeUndefined();
      expect(wireBody.iconEmoji).toBeUndefined();
    });

    it('maps Slack-compat attachment fields camelCase → snake_case', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.send({
        body: 'incident',
        attachments: [
          {
            color: 'danger',
            authorName: 'Alice',
            authorLink: 'https://a',
            authorIcon: 'https://i',
            title: 'Issue',
            titleLink: 'https://t',
            imageUrl: 'https://im',
            thumbUrl: 'https://th',
            footerIcon: 'https://fi',
            fields: [{ title: 'sev', value: 'p1', short: true }],
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const wireBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      const wireAttachments = wireBody.attachments as Array<Record<string, unknown>>;
      expect(wireAttachments).toHaveLength(1);
      const att = wireAttachments[0]!;

      // snake_case keys present.
      expect(att.author_name).toBe('Alice');
      expect(att.author_link).toBe('https://a');
      expect(att.author_icon).toBe('https://i');
      expect(att.title_link).toBe('https://t');
      expect(att.image_url).toBe('https://im');
      expect(att.thumb_url).toBe('https://th');
      expect(att.footer_icon).toBe('https://fi');

      // Same-form keys passed through untouched.
      expect(att.color).toBe('danger');
      expect(att.title).toBe('Issue');
      expect(att.fields).toEqual([{ title: 'sev', value: 'p1', short: true }]);

      // camelCase keys MUST NOT be on the wire.
      expect(att.authorName).toBeUndefined();
      expect(att.authorLink).toBeUndefined();
      expect(att.authorIcon).toBeUndefined();
      expect(att.titleLink).toBeUndefined();
      expect(att.imageUrl).toBeUndefined();
      expect(att.thumbUrl).toBeUndefined();
      expect(att.footerIcon).toBeUndefined();
    });

    it('404 (deleted webhook) → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.statusCode).toBe(404);
      }
    });

    it('429 + Retry-After: 15 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '15',
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
          retryAfter: '15',
          retryAfterSeconds: 15,
        });
      }
    });

    it('_passthrough merges with attachment mapping', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.send({
        body: 'hi',
        attachments: [{ color: 'danger', text: 'attached' }],
        _passthrough: {
          // Per merge-passthrough semantics, passthrough.body deep-merges with
          // connector body; arrays are replaced (not deep-merged element-wise).
          // Here we instead exercise top-level extension and header merge.
          body: { metadata: { trace_id: 't-1' } },
          headers: { 'X-Trace-Id': 't-1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;

      // Connector-produced attachment mapping is preserved.
      expect(wireBody.attachments).toEqual([{ color: 'danger', text: 'attached' }]);
      expect(wireBody.text).toBe('hi');
      expect(wireBody.metadata).toEqual({ trace_id: 't-1' });

      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Trace-Id': 't-1',
        })
      );

      // Compile-time contract: `to` IS preserved on MattermostNarrowedInput
      // as the optional channel override; the connector
      // translates it to the wire `channel` field. So this must type-check.
      void (async () => connector.send({ to: 'x', body: 'y' }));
    });

    it('missing config.webhookUrl → ConnectorError invalid_request', async () => {
      const noUrlConnector = new MattermostChatConnector({});

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
  });
});
