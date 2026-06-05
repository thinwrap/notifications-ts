import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostmarkEmailConnector } from './postmark.connector';
import type { PostmarkConfig } from './postmark.config';
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

const defaultConfig: PostmarkConfig = {
  serverToken: 'pm-test-token',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function postmarkSuccessResponse(
  overrides: Partial<{
    To: string;
    SubmittedAt: string;
    MessageID: string;
    ErrorCode: number;
    Message: string;
  }> = {},
): Response {
  return new Response(
    JSON.stringify({
      To: 'recipient@example.com',
      SubmittedAt: '2024-01-01T00:00:00Z',
      MessageID: 'pm-msg-123',
      ErrorCode: 0,
      Message: 'OK',
      ...overrides,
    }),
    { status: 200 },
  );
}

function postmarkErrorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('PostmarkEmailConnector', () => {
  let connector: PostmarkEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new PostmarkEmailConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('sends a simple message and returns the canonical EmailSendResult shape on 200 with ErrorCode 0', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse({ MessageID: 'abc' }));

      const result = await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
        text: 'Hi!',
      });

      expect(result).toMatchObject({
        success: true,
        status: 'sent',
        providerMessageId: 'abc',
      });
      expect(result.raw).toMatchObject({ MessageID: 'abc', ErrorCode: 0 });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.postmarkapp.com/email');
      expect(reqInit.method).toBe('POST');

      const headers = reqInit.headers as Record<string, string>;
      expect(headers['X-Postmark-Server-Token']).toBe('pm-test-token');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Accept).toBe('application/json');
    });

    it('hand-structures the wire body in PascalCase (From/To/Subject/HtmlBody/TextBody)', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

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

      expect(body.From).toBe('Test Sender <sender@example.com>');
      expect(body.To).toBe('recipient@example.com');
      expect(body.Subject).toBe('Hello');
      expect(body.HtmlBody).toBe('<p>Hi!</p>');
      expect(body.TextBody).toBe('Hi!');
    });

    it('composes From as "Name <addr>" when senderName is configured', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

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
      expect(body.From).toBe('Test Sender <sender@example.com>');
    });

    it('uses bare address when senderName is not configured', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());
      const conn = new PostmarkEmailConnector({
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
      expect(body.From).toBe('sender@example.com');
    });

    it('joins Cc/Bcc as comma-separated strings and maps ReplyTo', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
        subject: 'cc/bcc',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.Cc).toBe('cc1@example.com, cc2@example.com');
      expect(body.Bcc).toBe('bcc@example.com');
      expect(body.ReplyTo).toBe('reply@example.com');
    });

    // -------------------------------------------------------------------------
    // Single-tag normalization
    // -------------------------------------------------------------------------

    it('caps tags first-tag-wins when input has 3 tags', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'tags',
        text: 't',
        tags: ['a', 'b', 'c'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.Tag).toBe('a');
      // No plural Tags key, no leftover tags representation.
      expect(body.Tags).toBeUndefined();
      expect(body.tags).toBeUndefined();
    });

    it('omits Tag entirely when input.tags is undefined', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'no tags',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.Tag).toBeUndefined();
    });

    it('omits Tag when input.tags is an empty array', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'empty tags',
        text: 't',
        tags: [],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.Tag).toBeUndefined();
    });

    it('forwards a single tag verbatim as Tag', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'solo',
        text: 't',
        tags: ['solo'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.Tag).toBe('solo');
    });

    // -------------------------------------------------------------------------
    // Headers Record→array adapter
    // -------------------------------------------------------------------------

    it('converts headers Record into Postmark Headers array of {Name,Value}', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'headers',
        text: 't',
        headers: { 'X-Foo': '1', 'X-Bar': '2' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.Headers).toEqual([
        { Name: 'X-Foo', Value: '1' },
        { Name: 'X-Bar', Value: '2' },
      ]);
    });

    // -------------------------------------------------------------------------
    // Attachments
    // -------------------------------------------------------------------------

    it('maps Buffer attachments to Postmark Attachments with base64 Content', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());
      const fileBuf = Buffer.from('PDF-CONTENT-BYTES');

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'attach',
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
        Attachments: Array<Record<string, string>>;
      };
      expect(body.Attachments).toHaveLength(1);
      expect(body.Attachments[0]).toEqual({
        Name: 'report.pdf',
        Content: fileBuf.toString('base64'),
        ContentType: 'application/pdf',
      });
    });

    it('emits ContentID with cid: prefix when attachment.contentId is set', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

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
        Attachments: Array<Record<string, string>>;
      };
      expect(body.Attachments[0]).toEqual(
        expect.objectContaining({
          Name: 'logo.png',
          ContentID: 'cid:logo',
          ContentType: 'image/png',
        }),
      );
    });

    // -------------------------------------------------------------------------
    // MessageStream config casing-transformed _passthrough
    // -------------------------------------------------------------------------

    it('propagates configured messageStream into MessageStream on the wire body', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());
      const conn = new PostmarkEmailConnector({
        ...defaultConfig,
        messageStream: 'broadcasts',
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'stream',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.MessageStream).toBe('broadcasts');
    });

    it('applies PascalCase casing transform to _passthrough.body keys before merge', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'template',
        html: '<p>{{firstName}}</p>',
        _passthrough: {
          body: { templateModel: { firstName: 'Alex' } },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.TemplateModel).toEqual({ FirstName: 'Alex' });
      expect(body.templateModel).toBeUndefined();
    });

    it('forwards _passthrough.headers verbatim to the fetch call (no casing transform)', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'h',
        text: 't',
        _passthrough: {
          headers: { 'X-Custom-Header': 'value' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['X-Custom-Header']).toBe('value');
      expect(headers['X-Postmark-Server-Token']).toBe('pm-test-token');
    });

    it('folds _passthrough.query into the URL', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'q',
        text: 't',
        _passthrough: { query: { trace: 'on' } },
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.postmarkapp.com/email?trace=on');
    });

    // -------------------------------------------------------------------------
    // 2xx-with-embedded-error handling
    // -------------------------------------------------------------------------

    it('throws ConnectorError with invalid_recipient when 200 OK carries ErrorCode 300', async () => {
      mockFetch.mockResolvedValueOnce(
        postmarkSuccessResponse({
          ErrorCode: 300,
          Message: 'Inactive recipient',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'inactive@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(422);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toBe('Inactive recipient');
      }
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 401 unauthorized to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        postmarkErrorResponse(401, {
          ErrorCode: 10,
          Message: 'Bad or missing Server API token.',
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

    it('maps 422 with ErrorCode 300 (InactiveRecipient) to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        postmarkErrorResponse(422, {
          ErrorCode: 300,
          Message: 'Inactive recipient',
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
        expect(e.statusCode).toBe(422);
        expect(e.providerCode).toBe('invalid_recipient');
      }
    });

    it('maps 422 with ErrorCode 1003 (InvalidEmailRequest) to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        postmarkErrorResponse(422, {
          ErrorCode: 1003,
          Message: 'Invalid email request',
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
        expect(e.statusCode).toBe(422);
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('maps 429 to rate_limited', async () => {
      mockFetch.mockResolvedValueOnce(
        postmarkErrorResponse(429, {
          ErrorCode: 0,
          Message: 'Too many requests',
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

    it('maps 500 to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        postmarkErrorResponse(500, {
          ErrorCode: 0,
          Message: 'Internal server error',
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

    // -------------------------------------------------------------------------
    // Retry-After parsing
    // -------------------------------------------------------------------------

    it('parses integer Retry-After header into cause.retryAfter and cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '120',
          errorBody: { ErrorCode: 0, Message: 'Too many requests' },
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
          retryAfter: '120',
          retryAfterSeconds: 120,
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

    it('uses BYO fetch from config when provided', async () => {
      const byoFetch = vi.fn().mockResolvedValue(postmarkSuccessResponse());
      const conn = new PostmarkEmailConnector({
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
    it('has id "postmark" and channelType EMAIL', () => {
      expect(connector.id).toBe('postmark');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('sends a PascalCase JSON message with X-Postmark-Server-Token and returns { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse({ MessageID: 'pm-msg-123' }));

      const result = await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        html: '<p>Hello!</p>',
        text: 'Hello!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.postmarkapp.com/email');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': 'pm-test-token',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.From).toBe('Test Sender <sender@example.com>');
      expect(body.To).toBe('recipient@example.com');
      expect(body.Subject).toBe('Test Subject');
      expect(body.HtmlBody).toBe('<p>Hello!</p>');
      expect(body.TextBody).toBe('Hello!');

      expect(result).toEqual({
        id: 'pm-msg-123',
        date: expect.any(String),
      });
    });

    it('includes Cc, Bcc, and ReplyTo when provided', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

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

      expect(body.Cc).toBe('cc@example.com');
      expect(body.Bcc).toBe('bcc@example.com');
      expect(body.ReplyTo).toBe('reply@example.com');
    });

    it('maps attachments to Postmark format', async () => {
      mockFetch.mockResolvedValueOnce(postmarkSuccessResponse());

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
      const attachments = body.Attachments as Array<Record<string, string>>;

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual({
        Name: 'report.pdf',
        Content: fileBuffer.toString('base64'),
        ContentType: 'application/pdf',
      });
    });

    it('throws ConnectorError when Postmark returns non-zero ErrorCode', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ErrorCode: 300,
            Message: 'Invalid email request',
            MessageID: '',
            To: '',
            SubmittedAt: '',
          }),
          { status: 200 },
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
        // Brownfield now routes through canonical mapPostmarkErrorToProviderCode
        expect(connectorErr.providerCode).toBe('invalid_recipient');
        expect(connectorErr.providerMessage).toBe('Invalid email request');
      }
    });

    it('throws ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ErrorCode: 10, Message: 'Bad or missing Server API token.' }),
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
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Bad or missing Server API token.');
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
