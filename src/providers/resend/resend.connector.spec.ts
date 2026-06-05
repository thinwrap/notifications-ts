import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { ResendEmailConnector } from './resend.connector';
import type { ResendConfig } from './resend.config';
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

const defaultConfig: ResendConfig = {
  apiKey: 're_test_123',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function resendSuccessResponse(id = 'r_abc') {
  return new Response(JSON.stringify({ id }), { status: 200 });
}

function resendErrorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('ResendEmailConnector', () => {
  let connector: ResendEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new ResendEmailConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('sends a simple message and returns the canonical EmailSendResult shape', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse('r_abc'));

      const result = await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
        text: 'Hi!',
      });

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'r_abc',
        raw: { id: 'r_abc' },
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      // URL + method
      expect(url).toBe('https://api.resend.com/emails');
      expect(reqInit.method).toBe('POST');

      // Bearer auth + JSON content-type
      const headers = reqInit.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer re_test_123');
      expect(headers['Content-Type']).toBe('application/json');

      // Body shape — Resend wire keys are lowercase one-words
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        from: 'Test Sender <sender@example.com>',
        to: ['recipient@example.com'],
        subject: 'Hello',
        html: '<p>Hi!</p>',
        text: 'Hi!',
      });
    });

    it('omits senderName from from-address when not set on config', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());
      const conn = new ResendEmailConnector({ ...defaultConfig, senderName: undefined });

      await conn.send({
        from: 'sender@example.com',
        to: 'rcp@example.com',
        subject: 'Hi',
        text: 'plain',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.from).toBe('sender@example.com');
    });

    it('hand-maps replyTo to snake_case reply_to on the wire', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
        subject: 'Test',
        html: '<p>body</p>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.reply_to).toBe('reply@example.com');
      expect(body.cc).toEqual(['cc@example.com']);
      expect(body.bcc).toEqual(['bcc@example.com']);
    });

    it('maps Buffer attachments to base64-encoded content with content_type', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());
      const fileBuf = Buffer.from('PDF-CONTENT-BYTES');

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Attachment Test',
        html: '<p>See attached</p>',
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: fileBuf,
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        attachments: Array<Record<string, string>>;
      };
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]).toEqual({
        filename: 'report.pdf',
        content: fileBuf.toString('base64'),
        content_type: 'application/pdf',
      });
    });

    it('encodes string-typed attachment content as UTF-8 base64', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'String attach',
        text: 'plain',
        attachments: [
          { filename: 'note.txt', contentType: 'text/plain', content: 'hello' },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        attachments: Array<Record<string, string>>;
      };
      expect(body.attachments[0]!.content).toBe(
        Buffer.from('hello', 'utf-8').toString('base64'),
      );
    });

    it('maps tags: string[] to Resend [{ name: "tag", value }] wire shape', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Tagged',
        text: 'plain',
        tags: ['promo', 'newsletter'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.tags).toEqual([
        { name: 'tag', value: 'promo' },
        { name: 'tag', value: 'newsletter' },
      ]);
    });

    it('forwards Thinwrap headers field as Resend headers on the body', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Headers',
        text: 'plain',
        headers: { 'X-Entity-Ref-ID': 'abc-123' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.headers).toEqual({ 'X-Entity-Ref-ID': 'abc-123' });
    });

    it('forwards narrowed scheduledAt as scheduled_at on the wire', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Scheduled',
        text: 'plain',
        scheduledAt: '2026-06-01T10:00:00Z',
      } as never);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.scheduled_at).toBe('2026-06-01T10:00:00Z');
    });

    // -------------------------------------------------------------------------
    // _passthrough forwarding
    // -------------------------------------------------------------------------

    it('merges _passthrough.body into the request body', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Passthrough',
        text: 'plain',
        _passthrough: {
          body: { custom_field: 'vendor-extension-value' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.custom_field).toBe('vendor-extension-value');
    });

    it('forwards _passthrough.headers like Idempotency-Key to the fetch call', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Idempotent',
        text: 'plain',
        _passthrough: {
          headers: { 'Idempotency-Key': 'idem-abc-123' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('idem-abc-123');
      expect(headers.Authorization).toBe('Bearer re_test_123');
    });

    it('folds _passthrough.query into the URL', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Query',
        text: 'plain',
        _passthrough: { query: { trace: 'on' } },
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.resend.com/emails?trace=on');
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 401 missing_api_key to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        resendErrorResponse(401, {
          statusCode: 401,
          name: 'missing_api_key',
          message: 'Missing API key in the Authorization header',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('Missing API key in the Authorization header');
      }
    });

    it('maps 403 restricted_api_key to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        resendErrorResponse(403, {
          statusCode: 403,
          name: 'restricted_api_key',
          message: 'The API key is restricted',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(403);
        expect(e.providerCode).toBe('auth_failed');
      }
    });

    it('maps 422 validation_error with recipient message to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        resendErrorResponse(422, {
          statusCode: 422,
          name: 'validation_error',
          message: 'Invalid `to` recipient: not a valid email address',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'bad',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(422);
        expect(e.providerCode).toBe('invalid_recipient');
      }
    });

    it('maps 422 validation_error on non-recipient field to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        resendErrorResponse(422, {
          statusCode: 422,
          name: 'validation_error',
          message: 'The `subject` field is required',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: '',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(422);
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('maps 400 missing_required_field to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        resendErrorResponse(400, {
          statusCode: 400,
          name: 'missing_required_field',
          message: 'The `from` field is required',
        }),
      );

      try {
        await connector.send({
          from: '',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('maps 429 rate_limit_exceeded to rate_limited', async () => {
      mockFetch.mockResolvedValueOnce(
        resendErrorResponse(429, {
          statusCode: 429,
          name: 'rate_limit_exceeded',
          message: 'Too many requests',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(429);
        expect(e.providerCode).toBe('rate_limited');
      }
    });

    it('maps 5xx application_error to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        resendErrorResponse(500, {
          statusCode: 500,
          name: 'application_error',
          message: 'Internal server error',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });

    it('maps an unrecognized status (418) to unknown', async () => {
      mockFetch.mockResolvedValueOnce(
        resendErrorResponse(418, {
          statusCode: 418,
          name: 'teapot',
          message: 'Coffee not available',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(418);
        expect(e.providerCode).toBe('unknown');
      }
    });

    // -------------------------------------------------------------------------
    // Retry-After parsing
    // -------------------------------------------------------------------------

    it('parses integer Retry-After header into cause.retryAfter (raw) + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: {
            statusCode: 429,
            name: 'rate_limit_exceeded',
            message: 'Too many requests',
          },
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('rate_limited');
        // providerMessage stays pure vendor text
        expect(e.providerMessage).toBe('Too many requests');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('does not append Retry-After text when the header is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          errorBody: {
            statusCode: 429,
            name: 'rate_limit_exceeded',
            message: 'Too many requests',
          },
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerMessage).toBe('Too many requests');
      }
    });

    it('handles error response with no parseable JSON body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('garbage', { status: 500 }));

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.providerMessage).toBe('<no vendor message>');
      }
    });

    it('wraps network errors as ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ETIMEDOUT'));

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBeNull();
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });

    it('returns providerMessageId = null when Resend omits id in 2xx body (defensive)', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const result = await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'x',
        text: 't',
      });

      expect(result.providerMessageId).toBeNull();
      expect(result.success).toBe(true);
      expect(result.status).toBe('sent');
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('has id "resend" and channelType EMAIL', () => {
      expect(connector.id).toBe('resend');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('sends a JSON message with Bearer auth and returns { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse('resend-msg-123'));

      const result = await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        html: '<p>Hello!</p>',
        text: 'Hello!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.resend.com/emails');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer re_test_123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.from).toBe('Test Sender <sender@example.com>');
      expect(body.to).toEqual(['recipient@example.com']);
      expect(body.subject).toBe('Test Subject');
      expect(body.html).toBe('<p>Hello!</p>');
      expect(body.text).toBe('Hello!');

      expect(result).toEqual({
        id: 'resend-msg-123',
        date: expect.any(String),
      });
    });

    it('includes cc, bcc, and reply_to when provided', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test',
        html: '<p>Test</p>',
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.cc).toEqual(['cc@example.com']);
      expect(body.bcc).toEqual(['bcc@example.com']);
      expect(body.reply_to).toBe('reply@example.com');
    });

    it('maps attachments to Resend wire format', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      const fileBuffer = Buffer.from('file-content');
      await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Attachment Test',
        html: '<p>See attached</p>',
        attachments: [
          { mime: 'application/pdf', file: fileBuffer, name: 'report.pdf' },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      const attachments = body.attachments as Array<Record<string, string>>;

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual({
        filename: 'report.pdf',
        content: fileBuffer.toString('base64'),
        content_type: 'application/pdf',
      });
    });

    it('merges bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.sendMessage(
        { to: ['recipient@example.com'], subject: 'Test', html: '<p>Test</p>' },
        { _passthrough: { body: { tags: [{ name: 'env', value: 'test' }] } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.tags).toEqual([{ name: 'env', value: 'test' }]);
    });

    it('throws ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ name: 'validation_error', message: 'Invalid email' }),
          { status: 422 },
        ),
      );

      try {
        await connector.sendMessage({
          to: ['invalid'],
          subject: 'Test',
          html: '<p>Test</p>',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(422);
        // Brownfield now routes through canonical mapResendErrorToProviderCode
        expect(connectorErr.providerCode).toBe('invalid_request');
        expect(connectorErr.providerMessage).toBe('Invalid email');
      }
    });

    it('uses senderName from options over config', async () => {
      mockFetch.mockResolvedValueOnce(resendSuccessResponse());

      await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test',
        html: '<p>Test</p>',
        senderName: 'Override Sender',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.from).toBe('Override Sender <sender@example.com>');
    });
  });
});
