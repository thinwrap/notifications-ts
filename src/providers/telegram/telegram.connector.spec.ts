import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { TelegramChatConnector } from './telegram.connector';
import type { TelegramConfig } from './telegram.config';
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

const defaultConfig: TelegramConfig = {
  botToken: 'test-bot-token-123',
};

function successResponse(
  payload: Record<string, unknown> = { ok: true, result: { message_id: 42 } },
): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function errorResponse(
  status: number,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}

describe('TelegramChatConnector', () => {
  let connector: TelegramChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new TelegramChatConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('sends JSON body and returns canonical ChatSendResult on 2xx', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({ ok: true, result: { message_id: 12345 } }),
      );

      const result = await connector.send({
        to: '987654321',
        body: 'Hello from Telegram!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://api.telegram.org/bottest-bot-token-123/sendMessage',
      );
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.chat_id).toBe('987654321');
      expect(body.text).toBe('Hello from Telegram!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: '12345',
        raw: { ok: true, result: { message_id: 12345 } },
      });
      // Regression: providerMessageId is the string form of the integer message_id.
      expect(typeof result.providerMessageId).toBe('string');
    });

    it('hand-maps all nine narrowed fields to snake_case wire keys', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({ ok: true, result: { message_id: 1 } }),
      );

      await connector.send({
        to: '@channelname',
        body: 'Bold text and more',
        parseMode: 'MarkdownV2',
        entities: [{ type: 'bold', offset: 0, length: 5 }],
        disableNotification: true,
        protectContent: true,
        replyParameters: { message_id: 1 },
        replyMarkup: { inline_keyboard: [[{ text: 'Click', url: 'https://x' }]] },
        linkPreviewOptions: { is_disabled: true },
        messageThreadId: 7,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;

      expect(body.chat_id).toBe('@channelname');
      expect(body.text).toBe('Bold text and more');
      expect(body.parse_mode).toBe('MarkdownV2');
      expect(body.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
      expect(body.disable_notification).toBe(true);
      expect(body.protect_content).toBe(true);
      expect(body.reply_parameters).toEqual({ message_id: 1 });
      expect(body.reply_markup).toEqual({
        inline_keyboard: [[{ text: 'Click', url: 'https://x' }]],
      });
      expect(body.link_preview_options).toEqual({ is_disabled: true });
      expect(body.message_thread_id).toBe(7);

      // None of the camelCase TS keys should leak onto the wire.
      expect(body.parseMode).toBeUndefined();
      expect(body.disableNotification).toBeUndefined();
      expect(body.replyParameters).toBeUndefined();
      expect(body.linkPreviewOptions).toBeUndefined();
      expect(body.messageThreadId).toBeUndefined();
    });

    it('maps HTTP 400 + "chat not found" description to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        }),
      );

      try {
        await connector.send({ to: '0', body: 'Hello' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toContain('chat not found');
      }
    });

    it('maps HTTP 401 to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, {
          ok: false,
          error_code: 401,
          description: 'Unauthorized',
        }),
      );

      try {
        await connector.send({ to: '123', body: 'Hello' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toContain('Unauthorized');
      }
    });

    it('maps HTTP 429 with body.parameters.retry_after to rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      // outlier: Telegram emits retry_after in JSON body, NOT a
      // Retry-After header. The mock deliberately omits the header to catch
      // any accidental header-based fallback.
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          // No Retry-After header — Telegram emits retry_after in JSON body only.
          errorBody: {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 30 },
          },
        }),
      );

      try {
        await connector.send({ to: '123', body: 'Hello' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(429);
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('Too Many Requests');
        expect(e.cause).toMatchObject({
          retryAfter: '30',
          retryAfterSeconds: 30,
        });
      }
    });

    it('honors _passthrough.body + _passthrough.headers; throws invalid_request when `to` is missing', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({ ok: true, result: { message_id: 99 } }),
      );

      await connector.send({
        to: '123',
        body: 'Hi',
        _passthrough: {
          body: { allow_sending_without_reply: true },
          headers: { 'X-Trace-Id': 't-1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.allow_sending_without_reply).toBe(true);
      expect(body.chat_id).toBe('123');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Trace-Id': 't-1' }),
      );

      // Missing-`to` defensive guard.
      mockFetch.mockReset();
      try {
        await connector.send({
          // Runtime callers can erase types; simulate that here.
          to: '' as string,
          body: 'Hi',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_request');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('routes HTTP 200 + ok:false soft errors through mapVendorError', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        }),
      );

      try {
        await connector.send({ to: '0', body: 'Hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_recipient');
      }
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped `sendMessage()` surface (preserved verbatim)
  // ===========================================================================

  describe('.sendMessage() — brownfield Novu-shaped surface', () => {
    it('should have id "telegram" and channelType CHAT', () => {
      expect(connector.id).toBe('telegram');
      expect(connector.channelType).toBe(ChannelTypeEnum.CHAT);
    });

    it('should send a message with chat_id from options.channel', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        channel: '123456789',
        content: 'Hello from Telegram!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.telegram.org/bottest-bot-token-123/sendMessage');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.chat_id).toBe('123456789');
      expect(body.text).toBe('Hello from Telegram!');
      expect(body.parse_mode).toBe('HTML');

      expect(result).toEqual({ id: '42', date: expect.any(String) });
    });

    it('should default parse_mode to HTML', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        channel: '123456789',
        content: '<b>Bold text</b>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.parse_mode).toBe('HTML');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { channel: '123456789', content: 'Hello!' },
        { _passthrough: { body: { disable_notification: true } } }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.disable_notification).toBe(true);
      expect(body.chat_id).toBe('123456789');
    });

    it('should throw ConnectorError when API returns ok: false', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot was blocked by the user',
          }),
          { status: 200 }
        )
      );

      try {
        await connector.sendMessage({ channel: '123456789', content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(403);
        // Brownfield now routes through canonical mapVendorError
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Forbidden: bot was blocked by the user');
      }
    });

    it('should throw ConnectorError on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }),
          { status: 401 }
        )
      );

      try {
        await connector.sendMessage({ channel: '123456789', content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(401);
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Unauthorized');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({ channel: '123456789', content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network failure');
      }
    });
  });
});
