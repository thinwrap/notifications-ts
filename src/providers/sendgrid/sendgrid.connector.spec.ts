import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { SendgridEmailConnector } from './sendgrid.connector';
import type { SendgridConfig } from './sendgrid.config';
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

const defaultConfig: SendgridConfig = {
  apiKey: 'SG.test_key',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function sendgridSuccessResponse(messageId = 'SG.abc123') {
  return new Response(null, {
    status: 202,
    headers: { 'x-message-id': messageId },
  });
}

function sendgridErrorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('SendgridEmailConnector', () => {
  let connector: SendgridEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new SendgridEmailConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('sends a simple message and returns the canonical EmailSendResult shape (202 + x-message-id)', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse('SG.abc123'));

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
        providerMessageId: 'SG.abc123',
        raw: { messageId: 'SG.abc123' },
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
      expect(reqInit.method).toBe('POST');

      const headers = reqInit.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer SG.test_key');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('hand-structures the wire body in snake_case with top-level personalizations/from/subject/content', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
        text: 'Hi!',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;

      expect(Object.keys(body).sort()).toEqual(
        ['content', 'from', 'personalizations', 'subject'].sort(),
      );
      expect(body.from).toEqual({
        email: 'sender@example.com',
        name: 'Test Sender',
      });
      expect(body.subject).toBe('Hello');
      expect(body.personalizations).toEqual([
        { to: [{ email: 'recipient@example.com' }] },
      ]);
      expect(body.content).toEqual([
        { type: 'text/plain', value: 'Hi!' },
        { type: 'text/html', value: '<p>Hi!</p>' },
      ]);
    });

    it('composes from as { email, name } when senderName is configured', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
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
      expect(body.from).toEqual({
        email: 'sender@example.com',
        name: 'Test Sender',
      });
    });

    it('omits name from from-object when senderName is not configured', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());
      const conn = new SendgridEmailConnector({
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

    it('normalizes to/cc/bcc to [{ email }] arrays inside personalizations[0]', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
        subject: 'CC/BCC',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        personalizations: Array<Record<string, unknown>>;
      };
      expect(body.personalizations[0]!.to).toEqual([
        { email: 'recipient@example.com' },
      ]);
      expect(body.personalizations[0]!.cc).toEqual([
        { email: 'cc1@example.com' },
        { email: 'cc2@example.com' },
      ]);
      expect(body.personalizations[0]!.bcc).toEqual([
        { email: 'bcc@example.com' },
      ]);
    });

    it('hand-maps replyTo to reply_to as { email } on the wire body', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

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
      expect(body.reply_to).toEqual({ email: 'reply@example.com' });
    });

    it('maps Buffer attachments to base64 content with type and filename', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());
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
        content: fileBuf.toString('base64'),
        filename: 'report.pdf',
        type: 'application/pdf',
      });
    });

    it('emits content_id + disposition: inline when attachment.contentId is set', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

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
          content_id: 'logo',
          disposition: 'inline',
        }),
      );
    });

    it('encodes string-typed attachment content as UTF-8 base64', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'string attach',
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

    it('maps tags: string[] to SendGrid categories on the wire body', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'tags',
        text: 'plain',
        tags: ['promo', 'newsletter'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.categories).toEqual(['promo', 'newsletter']);
    });

    it('forwards Thinwrap headers field as SendGrid headers on the body', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'h',
        text: 't',
        headers: { 'X-Entity-Ref-ID': 'abc-123' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.headers).toEqual({ 'X-Entity-Ref-ID': 'abc-123' });
    });

    // -------------------------------------------------------------------------
    // canonical example: explicit per-connector casing transform on
    // `_passthrough.body` before mergePassthrough.
    // -------------------------------------------------------------------------

    it('applies casing transform to _passthrough.body keys before mergePassthrough (canonical)', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Templated',
        html: '<p>{{firstName}}</p>',
        _passthrough: {
          body: { dynamicTemplateData: { firstName: 'Alex' } },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.dynamic_template_data).toEqual({ first_name: 'Alex' });
      expect(body.dynamicTemplateData).toBeUndefined();
    });

    it('passes through already-snake_case _passthrough.body keys idempotently', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 't',
        text: 't',
        _passthrough: {
          body: { template_id: 'd-abc123' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.template_id).toBe('d-abc123');
    });

    it('forwards _passthrough.headers verbatim to the fetch call (no casing transform)', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'idem',
        text: 't',
        _passthrough: {
          headers: { 'X-Custom-Header': 'value', 'On-Behalf-Of': 'sub-account' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['X-Custom-Header']).toBe('value');
      expect(headers['On-Behalf-Of']).toBe('sub-account');
      expect(headers.Authorization).toBe('Bearer SG.test_key');
    });

    it('folds _passthrough.query into the URL', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'q',
        text: 't',
        _passthrough: { query: { trace: 'on' } },
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.sendgrid.com/v3/mail/send?trace=on');
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 400 with personalizations.*.email field error to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        sendgridErrorResponse(400, {
          errors: [
            {
              message: 'Does not contain a valid address.',
              field: 'personalizations.0.to.0.email',
              help: 'https://sendgrid.com',
            },
          ],
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'bad',
          subject: 'x',
          text: 't',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toBe('Does not contain a valid address.');
      }
    });

    it('maps 400 with from.email field error to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        sendgridErrorResponse(400, {
          errors: [
            {
              message: 'The from address does not match a verified Sender Identity',
              field: 'from.email',
            },
          ],
        }),
      );

      try {
        await connector.send({
          from: 'bad-sender@example.com',
          to: 'r@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_recipient');
      }
    });

    it('maps 400 generic malformed body to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        sendgridErrorResponse(400, {
          errors: [
            { message: 'The content array is required', field: 'content' },
          ],
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
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('maps 401 unauthorized to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        sendgridErrorResponse(401, {
          errors: [
            {
              message:
                'The provided authorization grant is invalid, expired, or revoked',
            },
          ],
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
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
      }
    });

    it('maps 403 forbidden / restricted_api_key to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        sendgridErrorResponse(403, {
          errors: [
            {
              message:
                'The API key does not have the required permissions to perform this action',
            },
          ],
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

    it('maps 413 payload too large to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        sendgridErrorResponse(413, {
          errors: [{ message: 'request entity too large' }],
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
        expect(e.statusCode).toBe(413);
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('maps 429 too many requests to rate_limited', async () => {
      mockFetch.mockResolvedValueOnce(
        sendgridErrorResponse(429, {
          errors: [{ message: 'Too many requests' }],
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

    it('maps 5xx server error to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        sendgridErrorResponse(500, {
          errors: [{ message: 'Internal server error' }],
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
        sendgridErrorResponse(418, {
          errors: [{ message: 'Coffee not available' }],
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

    // -------------------------------------------------------------------------
    // Retry-After parsing
    // -------------------------------------------------------------------------

    it('parses integer Retry-After header into cause.retryAfter and cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '90',
          errorBody: { errors: [{ message: 'Too many requests' }] },
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
        expect(e.providerMessage).toBe('Too many requests');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '90',
          retryAfterSeconds: 90,
        });
      }
    });

    it('does not append Retry-After text when the header is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          errorBody: { errors: [{ message: 'Too many requests' }] },
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

    it('returns providerMessageId = null when SendGrid omits x-message-id header (defensive)', async () => {
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
      const byoFetch = vi.fn().mockResolvedValue(sendgridSuccessResponse());
      const conn = new SendgridEmailConnector({
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
    it('has id "sendgrid" and channelType EMAIL', () => {
      expect(connector.id).toBe('sendgrid');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('sends a JSON message with Bearer auth and returns { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse('sg-msg-123'));

      const result = await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        html: '<p>Hello!</p>',
        text: 'Hello!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer SG.test_key',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.from).toEqual({
        email: 'sender@example.com',
        name: 'Test Sender',
      });
      expect(body.personalizations).toEqual([
        { to: [{ email: 'recipient@example.com' }], subject: 'Test Subject' },
      ]);
      expect(body.content).toEqual([
        { type: 'text/plain', value: 'Hello!' },
        { type: 'text/html', value: '<p>Hello!</p>' },
      ]);

      expect(result).toEqual({
        id: 'sg-msg-123',
        date: expect.any(String),
      });
    });

    it('includes cc, bcc, and reply_to when provided', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

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
      const personalizations = (body.personalizations as Record<string, unknown>[])[0]!;

      expect(personalizations.cc).toEqual([{ email: 'cc@example.com' }]);
      expect(personalizations.bcc).toEqual([{ email: 'bcc@example.com' }]);
      expect(body.reply_to).toEqual({ email: 'reply@example.com' });
    });

    it('maps attachments to SendGrid format', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

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
        content: fileBuffer.toString('base64'),
        type: 'application/pdf',
        filename: 'report.pdf',
      });
    });

    it('merges bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(sendgridSuccessResponse());

      await connector.sendMessage(
        { to: ['recipient@example.com'], subject: 'Test', html: '<p>Test</p>' },
        { _passthrough: { body: { tracking_settings: { click_tracking: { enable: true } } } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.tracking_settings).toBeDefined();
    });

    it('throws ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ message: 'The provided authorization grant is invalid', field: 'authorization' }],
          }),
          { status: 401 },
        ),
      );

      try {
        await connector.sendMessage({
          to: ['recipient@example.com'],
          subject: 'Test',
          html: '<p>Test</p>',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(401);
        // Brownfield now routes through canonical mapSendgridErrorToProviderCode
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('The provided authorization grant is invalid');
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
