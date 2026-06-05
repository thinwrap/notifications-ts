import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MailerSendEmailConnector } from './mailersend.connector';
import type { MailerSendConfig } from './mailersend.config';
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

const defaultConfig: MailerSendConfig = {
  apiToken: 'mlsn_test_123',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function mailersendSuccessResponse(messageId = 'ms-msg-123') {
  return new Response(null, {
    status: 202,
    headers: { 'x-message-id': messageId },
  });
}

function mailersendErrorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('MailerSendEmailConnector', () => {
  let connector: MailerSendEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new MailerSendEmailConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('sends a simple message and returns the canonical EmailSendResult shape (202 + x-message-id)', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse('ms-msg-abc'));

      const result = await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
        text: 'Hi!',
      });

      expect(result).toEqual({
        success: true,
        status: 'queued',
        providerMessageId: 'ms-msg-abc',
        raw: { messageId: 'ms-msg-abc' },
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.mailersend.com/v1/email');
      expect(reqInit.method).toBe('POST');

      const headers = reqInit.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer mlsn_test_123');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    });

    it('hand-structures from and to as { email, name? } objects in the wire body', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;

      expect(body.from).toEqual({
        email: 'sender@example.com',
        name: 'Test Sender',
      });
      expect(body.to).toEqual([{ email: 'recipient@example.com' }]);
      expect(body.subject).toBe('Hello');
      expect(body.html).toBe('<p>Hi!</p>');
    });

    it('omits name from from-object when senderName is not configured', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());
      const conn = new MailerSendEmailConnector({
        ...defaultConfig,
        senderName: undefined,
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'x',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.from).toEqual({ email: 'sender@example.com' });
    });

    it('hand-maps replyTo to reply_to as a one-element array of { email } objects', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        replyTo: 'reply@example.com',
        subject: 'x',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.reply_to).toEqual([{ email: 'reply@example.com' }]);
    });

    it('maps Buffer attachments to base64 content with content_type and filename', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());
      const fileBuf = Buffer.from('PDF-CONTENT-BYTES');

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Attach',
        html: '<p>see</p>',
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

    it('emits id + disposition: inline when attachment.contentId is set', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'inline',
        html: '<p><img src="cid:logo"></p>',
        attachments: [
          {
            filename: 'logo.png',
            contentType: 'image/png',
            content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            contentId: 'logo',
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        attachments: Array<Record<string, string>>;
      };
      expect(body.attachments[0]).toEqual(
        expect.objectContaining({
          id: 'logo',
          disposition: 'inline',
        }),
      );
    });

    it('converts headers Record to MailerSend Array<{name, value}> shape', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'h',
        text: 't',
        headers: { 'X-Foo': '1', 'X-Bar': '2' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.headers).toEqual([
        { name: 'X-Foo', value: '1' },
        { name: 'X-Bar', value: '2' },
      ]);
    });

    it('truncates tags beyond MailerSend 5-tag limit silently (first-5-wins)', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'tags',
        text: 't',
        tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    // -------------------------------------------------------------------------
    // explicit per-connector casing transform on `_passthrough.body`.
    // -------------------------------------------------------------------------

    it('applies casing transform to _passthrough.body keys before mergePassthrough', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Templated',
        html: '<p>{{firstName}}</p>',
        _passthrough: {
          body: {
            templateId: 'tpl_1',
            sendAt: 1234567890,
            inReplyTo: '<abc@mta>',
          },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.template_id).toBe('tpl_1');
      expect(body.send_at).toBe(1234567890);
      expect(body.in_reply_to).toBe('<abc@mta>');
      expect(body.templateId).toBeUndefined();
      expect(body.sendAt).toBeUndefined();
      expect(body.inReplyTo).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 401 invalid token to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        mailersendErrorResponse(401, { message: 'Unauthenticated.' }),
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
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('Unauthenticated.');
      }
    });

    it('maps 422 with to.* field error to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        mailersendErrorResponse(422, {
          message: 'The given data was invalid.',
          errors: { 'to.0.email': ['The to.0.email must be a valid email address.'] },
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

    it('maps 422 with other field error to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        mailersendErrorResponse(422, {
          message: 'The given data was invalid.',
          errors: { subject: ['The subject field is required.'] },
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

    it('maps 429 too many requests to rate_limited', async () => {
      mockFetch.mockResolvedValueOnce(
        mailersendErrorResponse(429, { message: 'Too Many Attempts.' }),
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

    it('maps 5xx server error to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        mailersendErrorResponse(500, { message: 'Internal server error' }),
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

    it('parses integer Retry-After header into cause.retryAfter and cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { message: 'Too Many Attempts.' },
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
        expect(e.providerMessage).toBe('Too Many Attempts.');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
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

    it('returns providerMessageId = null when MailerSend omits x-message-id header (defensive)', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));

      const result = await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'x',
        text: 't',
      });

      expect(result.providerMessageId).toBeNull();
      expect(result.success).toBe(true);
      expect(result.status).toBe('queued');
    });

    it('uses BYO fetch from config when provided', async () => {
      const byoFetch = vi.fn().mockResolvedValue(mailersendSuccessResponse());
      const conn = new MailerSendEmailConnector({
        ...defaultConfig,
        fetch: byoFetch as unknown as typeof fetch,
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'byo',
        text: 't',
      });

      expect(byoFetch).toHaveBeenCalledOnce();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('has id "mailersend" and channelType EMAIL', () => {
      expect(connector.id).toBe('mailersend');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('sends a JSON message with Bearer auth and returns { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse('ms-msg-123'));

      const result = await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        html: '<p>Hello!</p>',
        text: 'Hello!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.mailersend.com/v1/email');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer mlsn_test_123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.from).toEqual({ email: 'sender@example.com', name: 'Test Sender' });
      expect(body.to).toEqual([{ email: 'recipient@example.com' }]);
      expect(body.subject).toBe('Test Subject');
      expect(body.html).toBe('<p>Hello!</p>');
      expect(body.text).toBe('Hello!');

      expect(result).toEqual({
        id: 'ms-msg-123',
        date: expect.any(String),
      });
    });

    it('includes cc, bcc, and reply_to when provided', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

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

      expect(body.cc).toEqual([{ email: 'cc@example.com' }]);
      expect(body.bcc).toEqual([{ email: 'bcc@example.com' }]);
      expect(body.reply_to).toEqual([{ email: 'reply@example.com' }]);
    });

    it('maps attachments to MailerSend format', async () => {
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

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
      mockFetch.mockResolvedValueOnce(mailersendSuccessResponse());

      await connector.sendMessage(
        { to: ['recipient@example.com'], subject: 'Test', html: '<p>Test</p>' },
        { _passthrough: { body: { tags: ['transactional'] } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.tags).toEqual(['transactional']);
    });

    it('throws ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'validation_error', message: 'Invalid email address' }), { status: 422 }),
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
        expect(connectorErr.providerMessage).toBe('Invalid email address');
      }
    });

    it('throws ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({
          to: ['recipient@example.com'],
          subject: 'Test',
          html: '<p>Test</p>',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network failure');
      }
    });
  });
});
