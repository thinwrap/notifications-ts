import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { LineChatConnector } from './line.connector';
import type { LineConfig } from './line.config';
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

const defaultConfig: LineConfig = {
  channelAccessToken: 'line-access-token-123',
};

function successResponse(
  payload: Record<string, unknown> = {
    sentMessages: [{ id: 'line-msg-456', quoteToken: 'qt-abc' }],
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

describe('LineChatConnector', () => {
  let connector: LineChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new LineChatConnector(defaultConfig);
  });

  it('should have id "line" and channelType CHAT', () => {
    expect(connector.id).toBe('line');
    expect(connector.channelType).toBe(ChannelTypeEnum.CHAT);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('synthesizes a text message from `body` on the no-`messages` path', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({
          sentMessages: [{ id: '12345678901234' }],
        }),
      );

      const result = await connector.send({
        to: 'U1234567890abcdef',
        body: 'Hello from LINE!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.line.me/v2/bot/message/push');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer line-access-token-123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.to).toBe('U1234567890abcdef');
      expect(body.messages).toEqual([
        { type: 'text', text: 'Hello from LINE!' },
      ]);

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: '12345678901234',
        raw: { sentMessages: [{ id: '12345678901234' }] },
      });
    });

    it('uses explicit `messages` directly and ignores `body` (sticker)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: 'U1234567890abcdef',
        body: 'IGNORED when messages is set',
        messages: [
          { type: 'sticker', packageId: '446', stickerId: '1988' },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.messages).toEqual([
        { type: 'sticker', packageId: '446', stickerId: '1988' },
      ]);
      // Body is not auto-inserted when messages is set.
      expect(body.text).toBeUndefined();
    });

    it('serializes a Flex message with camelCase wire keys', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: 'U1234567890abcdef',
        body: 'fallback',
        messages: [
          {
            type: 'flex',
            altText: 'Order confirmation',
            contents: {
              type: 'bubble',
              body: {
                type: 'box',
                layout: 'vertical',
                contents: [{ type: 'text', text: 'Thank you!' }],
              },
            },
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(body.messages[0]!.type).toBe('flex');
      expect(body.messages[0]!.altText).toBe('Order confirmation');
      expect(
        (body.messages[0]!.contents as Record<string, unknown>).type,
      ).toBe('bubble');
    });

    it('maps 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, { message: 'Authentication failed' }),
      );

      try {
        await connector.send({
          to: 'U1234567890abcdef',
          body: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.statusCode).toBe(401);
        expect(ce.providerCode).toBe('auth_failed');
      }
    });

    it('maps 400 + "not found" body.message → invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          message:
            'The user is not found, or not yet a friend of the bot account.',
        }),
      );

      try {
        await connector.send({
          to: 'U_unknown',
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

    it('maps 429 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '30',
          errorBody: { message: 'Too many requests' },
        }),
      );

      try {
        await connector.send({
          to: 'U1234567890abcdef',
          body: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('rate_limited');
        expect(ce.providerMessage).toBe('Too many requests');
        expect(ce.cause).toMatchObject({
          retryAfter: '30',
          retryAfterSeconds: 30,
        });
      }
    });

    it('emits `notificationDisabled`, `customAggregationUnits`, deep-merges `_passthrough.body`, and guards missing `to`', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: 'U1234567890abcdef',
        body: 'Campaign blast',
        notificationDisabled: true,
        customAggregationUnits: ['campaign-q4', 'priority'],
        _passthrough: {
          body: { retryKey: 'idem-token-abc' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      // camelCase wire keys.
      expect(body.notificationDisabled).toBe(true);
      expect(body.customAggregationUnits).toEqual([
        'campaign-q4',
        'priority',
      ]);
      // Passthrough sibling key survives the merge.
      expect(body.retryKey).toBe('idem-token-abc');

      // Missing-`to` guard.
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

    it('wraps fetch network errors as provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.send({
          to: 'U1234567890abcdef',
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
    it('should send a push message with Bearer auth', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        channel: 'U1234567890abcdef',
        content: 'Hello from LINE!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.line.me/v2/bot/message/push');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer line-access-token-123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.to).toBe('U1234567890abcdef');
      expect(body.messages).toEqual([
        { type: 'text', text: 'Hello from LINE!' },
      ]);

      expect(result).toEqual({ id: 'line-msg-456', date: expect.any(String) });
    });

    it('should extract message ID from sentMessages response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sentMessages: [{ id: 'custom-line-id' }] }),
          { status: 200 },
        ),
      );

      const result = await connector.sendMessage({
        channel: 'U1234567890abcdef',
        content: 'Test',
      });

      expect(result.id).toBe('custom-line-id');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { channel: 'U1234567890abcdef', content: 'Hello!' },
        { _passthrough: { body: { notificationDisabled: true } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.notificationDisabled).toBe(true);
      expect(body.to).toBe('U1234567890abcdef');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: 'The request body has 1 error(s)' }),
          { status: 400 },
        ),
      );

      try {
        await connector.sendMessage({
          channel: 'U1234567890abcdef',
          content: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(400);
        // Brownfield now routes through canonical mapVendorError
        expect(connectorErr.providerCode).toBe('invalid_request');
        expect(connectorErr.providerMessage).toBe(
          'The request body has 1 error(s)',
        );
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({
          channel: 'U1234567890abcdef',
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
