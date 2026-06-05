import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { WhatsAppChatConnector } from './whatsapp-business.connector';
import type { WhatsAppBusinessConfig } from './whatsapp-business.config';
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

const defaultConfig: WhatsAppBusinessConfig = {
  accessToken: 'wa-access-token-123',
  phoneNumberId: '1234567890',
};

function successResponse(
  payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    contacts: [{ input: '+14155550100', wa_id: '14155550100' }],
    messages: [{ id: 'wamid.HBgNMTIzNDU2Nzg5MA==' }],
  },
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

describe('WhatsAppChatConnector', () => {
  let connector: WhatsAppChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new WhatsAppChatConnector(defaultConfig);
  });

  it('should have id "whatsapp-business" and channelType CHAT', () => {
    expect(connector.id).toBe('whatsapp-business');
    expect(connector.channelType).toBe(ChannelTypeEnum.CHAT);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('sends a text message with Bearer auth and returns canonical ChatSendResult', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '+14155550100',
        body: 'Hello from WhatsApp!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer wa-access-token-123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.recipient_type).toBe('individual');
      expect(body.to).toBe('+14155550100');
      expect(body.type).toBe('text');
      expect(body.text).toEqual({ body: 'Hello from WhatsApp!' });

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'wamid.HBgNMTIzNDU2Nzg5MA==',
        raw: expect.objectContaining({
          messages: [{ id: 'wamid.HBgNMTIzNDU2Nzg5MA==' }],
        }),
      });
    });

    it('serializes a template message (type=template) and ignores `body`', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+14155550100',
        body: 'IGNORED for templates',
        type: 'template',
        template: {
          name: 'hello_world',
          language: { code: 'en_US' },
          components: [
            {
              type: 'body',
              parameters: [{ type: 'text', text: 'Dima' }],
            },
          ],
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.type).toBe('template');
      expect(body.template).toEqual({
        name: 'hello_world',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Dima' }] },
        ],
      });
      // Body is explicitly ignored for template messages.
      expect(body.text).toBeUndefined();
    });

    it('serializes an interactive message (type=interactive) with Bearer auth', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+14155550100',
        body: 'IGNORED for interactive',
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Pick one' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
              { type: 'reply', reply: { id: 'no', title: 'No' } },
            ],
          },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer wa-access-token-123',
        }),
      );
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.type).toBe('interactive');
      expect(body.interactive).toEqual({
        type: 'button',
        body: { text: 'Pick one' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'no', title: 'No' } },
          ],
        },
      });
      // Body is explicitly ignored for interactive messages.
      expect(body.text).toBeUndefined();
    });

    it('maps 401 / errorCode 190 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, {
          error: {
            code: 190,
            message: 'Invalid OAuth access token',
            type: 'OAuthException',
          },
        }),
      );

      try {
        await connector.send({
          to: '+14155550100',
          body: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.statusCode).toBe(401);
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.providerMessage).toBe('Invalid OAuth access token');
      }
    });

    it('maps 400 + errorCode 131008 → invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          error: {
            code: 131008,
            message: 'Recipient phone number not in allowed list',
            error_subcode: 2018027,
          },
        }),
      );

      try {
        await connector.send({
          to: '+14155550100',
          body: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.statusCode).toBe(400);
        expect(ce.providerCode).toBe('invalid_recipient');
      }
    });

    it('maps errorCode 80007 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: {
            error: { code: 80007, message: 'Rate limit hit' },
          },
        }),
      );

      try {
        await connector.send({
          to: '+14155550100',
          body: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('rate_limited');
        expect(ce.providerMessage).toBe('Rate limit hit');
        expect(ce.cause).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('honors `graphApiVersion` override in the URL', async () => {
      const customConnector = new WhatsAppChatConnector({
        ...defaultConfig,
        graphApiVersion: 'v20.0',
      });
      mockFetch.mockResolvedValueOnce(successResponse());

      await customConnector.send({
        to: '+14155550100',
        body: 'Hello!',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://graph.facebook.com/v20.0/1234567890/messages');
    });

    it('merges `_passthrough.body.context` with input.context (deep merge)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+14155550100',
        body: 'Reply',
        context: { messageId: 'wamid.original' },
        _passthrough: {
          body: { biz_opaque_callback_data: 'tracking-token-abc' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      // input.context.messageId → wire key message_id.
      expect(body.context).toEqual({ message_id: 'wamid.original' });
      // Passthrough sibling key survives the merge.
      expect(body.biz_opaque_callback_data).toBe('tracking-token-abc');
    });

    it('throws invalid_request when `to` is missing', async () => {
      try {
        // @ts-expect-error — runtime guard for missing `to`.
        await connector.send({ body: 'No recipient' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.statusCode).toBe(400);
      }
    });

    it('emits `text.preview_url` when previewUrl is set', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+14155550100',
        body: 'Check https://example.com',
        previewUrl: true,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        text: Record<string, unknown>;
      };
      expect(body.text).toEqual({
        body: 'Check https://example.com',
        preview_url: true,
      });
    });

    it('wraps fetch network errors as provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.send({
          to: '+14155550100',
          body: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('provider_unavailable');
        expect(ce.statusCode).toBeNull();
      }
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped `sendMessage()` surface — preserved.
  // ===========================================================================

  describe('sendMessage (brownfield Novu-shaped surface)', () => {
    it('should send a text message with Bearer auth', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        channel: '14155550100',
        content: 'Hello from WhatsApp!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer wa-access-token-123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.to).toBe('14155550100');
      expect(body.type).toBe('text');
      expect(body.text).toEqual({ body: 'Hello from WhatsApp!' });

      expect(result).toEqual({
        id: 'wamid.HBgNMTIzNDU2Nzg5MA==',
        date: expect.any(String),
      });
    });

    it('should extract message ID from response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ messages: [{ id: 'wamid.custom-id' }] }),
          { status: 200 },
        ),
      );

      const result = await connector.sendMessage({
        channel: '14155550100',
        content: 'Test',
      });

      expect(result.id).toBe('wamid.custom-id');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { channel: '14155550100', content: 'Hello!' },
        {
          _passthrough: {
            body: {
              type: 'template',
              template: { name: 'hello_world', language: { code: 'en_US' } },
            },
          },
        },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.template).toEqual({
        name: 'hello_world',
        language: { code: 'en_US' },
      });
      expect(body.type).toBe('template');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } }),
          { status: 400 },
        ),
      );

      try {
        await connector.sendMessage({
          channel: '14155550100',
          content: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(400);
        // Brownfield now routes through canonical mapVendorError
        expect(connectorErr.providerCode).toBe('invalid_request');
        expect(connectorErr.providerMessage).toBe('Invalid parameter');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({
          channel: '14155550100',
          content: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network failure');
      }
    });
  });
});
