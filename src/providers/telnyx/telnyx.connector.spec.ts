import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { TelnyxSmsConnector } from './telnyx.connector';
import type { TelnyxConfig } from './telnyx.config';
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

const defaultConfig: TelnyxConfig = {
  apiKey: 'KEY_test_123',
  from: '+15551234567',
};

function successResponse(
  overrides: Partial<{ id: string; type: 'SMS' | 'MMS' }> = {},
): Response {
  return new Response(
    JSON.stringify({
      data: {
        id: overrides.id ?? 'telnyx-msg-123',
        record_type: 'message',
        direction: 'outbound',
        type: overrides.type ?? 'SMS',
        from: { phone_number: '+15551234567' },
        to: [{ phone_number: '+15559876543', status: 'queued' }],
        text: 'Hello',
      },
    }),
    { status: 200 },
  );
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('TelnyxSmsConnector', () => {
  let connector: TelnyxSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new TelnyxSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path: POSTs JSON body with Bearer auth and unwraps data.id into providerMessageId', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '+15559876543',
        body: 'Hello from Telnyx!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.telnyx.com/v2/messages');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer KEY_test_123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.from).toBe('+15551234567');
      expect(body.to).toBe('+15559876543');
      expect(body.text).toBe('Hello from Telnyx!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'telnyx-msg-123',
        raw: expect.objectContaining({
          data: expect.objectContaining({ id: 'telnyx-msg-123' }),
        }),
      });
    });

    it('messagingProfileId is accepted as alternative to from (writes messaging_profile_id, omits from)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const noFromConnector = new TelnyxSmsConnector({
        apiKey: 'KEY_test_123',
      });

      await noFromConnector.send({
        to: '+15559876543',
        body: 'Hi',
        messagingProfileId: 'mp-12345',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.from).toBeUndefined();
      expect(body.messaging_profile_id).toBe('mp-12345');
      expect(body.to).toBe('+15559876543');
    });

    it('MMS with mediaUrls: writes media_urls array and type=MMS on the wire', async () => {
      mockFetch.mockResolvedValueOnce(successResponse({ type: 'MMS' }));

      await connector.send({
        to: '+15559876543',
        body: 'See attached',
        type: 'MMS',
        mediaUrls: ['https://a.png', 'https://b.png'],
        subject: 'Photos',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.type).toBe('MMS');
      expect(body.media_urls).toEqual(['https://a.png', 'https://b.png']);
      expect(body.subject).toBe('Photos');
    });

    it('webhook overrides serialize as snake_case keys (webhook_url, webhook_failover_url, use_profile_webhooks, auto_detect)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hi',
        webhookUrl: 'https://example.com/wh',
        webhookFailoverUrl: 'https://example.com/wh-failover',
        useProfileWebhooks: false,
        autoDetect: true,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.webhook_url).toBe('https://example.com/wh');
      expect(body.webhook_failover_url).toBe('https://example.com/wh-failover');
      expect(body.use_profile_webhooks).toBe(false);
      expect(body.auto_detect).toBe(true);
    });

    it('maps 422 with errors[0].code=to_number_invalid → invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(422, {
          errors: [
            {
              code: 'to_number_invalid',
              title: 'Invalid To Number',
              detail: 'The to number is invalid',
            },
          ],
        }),
      );

      try {
        await connector.send({ to: '+1invalid', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(422);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toBe('The to number is invalid');
      }
    });

    it('maps 400 with errors[0].code=messaging_profile_id_not_found → invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          errors: [
            {
              code: 'messaging_profile_id_not_found',
              title: 'Profile Not Found',
              detail: 'No messaging profile found',
            },
          ],
        }),
      );

      try {
        await connector.send({
          to: '+15559876543',
          body: 'x',
          messagingProfileId: 'bogus',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_recipient');
      }
    });

    it('maps 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, {
          errors: [{ code: 'unauthorized', detail: 'Invalid API key' }],
        }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
      }
    });

    it('maps 429 with Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { errors: [{ code: 'too_many_requests', detail: 'Rate limited' }] },
        }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('Rate limited');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('maps 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, {
          errors: [{ code: 'internal_error', detail: 'Internal Server Error' }],
        }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });

    it('maps 400 (default — no specific errors[0].code) → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          errors: [{ code: 'some_other_code', detail: 'Bad request' }],
        }),
      );

      try {
        await connector.send({ to: '+15559876543', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('_passthrough body + headers honored (custom field merged into JSON body; X-Idempotency-Key in headers)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+15559876543',
        body: 'Hello',
        _passthrough: {
          body: { custom_field: 'x' },
          headers: { 'X-Idempotency-Key': 'k1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const parsed = JSON.parse(reqInit.body as string) as Record<
        string,
        unknown
      >;
      expect(parsed.custom_field).toBe('x');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Idempotency-Key': 'k1' }),
      );
    });

    it('throws invalid_request when neither from nor messagingProfileId is available', async () => {
      const noFromConnector = new TelnyxSmsConnector({
        apiKey: 'KEY_test_123',
      });

      try {
        await noFromConnector.send({ to: '+15559876543', body: 'Hi' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(400);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('wraps fetch network errors as ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await connector.send({ to: '+15559876543', body: 'x' });
        expect.unreachable();
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
    it('should have id "telnyx" and channelType SMS', () => {
      expect(connector.id).toBe('telnyx');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('should send a JSON message with Bearer auth and return { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello from Telnyx!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.telnyx.com/v2/messages');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer KEY_test_123',
        })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.from).toBe('+15551234567');
      expect(body.to).toBe('+15559876543');
      expect(body.text).toBe('Hello from Telnyx!');

      expect(result).toEqual({ id: 'telnyx-msg-123', date: expect.any(String) });
    });

    it('should use options.from over config.from', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        to: '+15559876543',
        content: 'Hello',
        from: '+15550000000',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.from).toBe('+15550000000');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ code: '40002', detail: 'Invalid phone number', title: 'Invalid' }],
          }),
          { status: 422 }
        )
      );

      try {
        await connector.sendMessage({ to: 'invalid', content: 'Hello' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(422);
        // Brownfield now routes through canonical mapping
        expect(connectorErr.providerCode).toBe('invalid_recipient');
        expect(connectorErr.providerMessage).toBe('Invalid phone number');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({ to: '+15559876543', content: 'Hello' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network failure');
      }
    });
  });
});
