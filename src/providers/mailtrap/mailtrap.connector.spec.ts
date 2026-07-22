import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MailtrapEmailConnector } from './mailtrap.connector';
import type { MailtrapConfig } from './mailtrap.config';
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

const productionConfig: MailtrapConfig = {
  apiToken: 'mt_test_123',
  mode: 'production',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

const sandboxConfig: MailtrapConfig = {
  apiToken: 'mt_test_123',
  mode: 'sandbox',
  inboxId: 'abc',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function successResponse(
  overrides: Partial<{ success: boolean; message_ids: string[] }> = {},
): Response {
  return new Response(
    JSON.stringify({
      success: true,
      message_ids: ['mt-msg-123'],
      ...overrides,
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

describe('MailtrapEmailConnector', () => {
  let connector: MailtrapEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new MailtrapEmailConnector(productionConfig);
  });

  // ===========================================================================
  // Constructor validation
  // ===========================================================================

  describe('constructor validation', () => {
    it('throws ConnectorError when mode is "sandbox" but inboxId is missing', () => {
      expect(
        () =>
          new MailtrapEmailConnector({
            apiToken: 't',
            mode: 'sandbox',
            from: 's@example.com',
          }),
      ).toThrow(ConnectorError);
      try {
        new MailtrapEmailConnector({
          apiToken: 't',
          mode: 'sandbox',
          from: 's@example.com',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(0);
        expect(e.message).toContain('sandbox mode requires inboxId');
      }
    });

    it('throws ConnectorError when mode is "production" but inboxId is provided', () => {
      expect(
        () =>
          new MailtrapEmailConnector({
            apiToken: 't',
            mode: 'production',
            inboxId: 'abc',
            from: 's@example.com',
          }),
      ).toThrow(ConnectorError);
      try {
        new MailtrapEmailConnector({
          apiToken: 't',
          mode: 'production',
          inboxId: 'abc',
          from: 's@example.com',
        });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(0);
        expect(e.message).toContain('production mode forbids inboxId');
      }
    });

    it('throws ConnectorError when mode is neither "sandbox" nor "production"', () => {
      expect(
        () =>
          new MailtrapEmailConnector({
            apiToken: 't',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mode: 'staging' as any,
            from: 's@example.com',
          }),
      ).toThrow(ConnectorError);
    });

    it('constructs successfully for a valid sandbox config', () => {
      expect(
        () => new MailtrapEmailConnector(sandboxConfig),
      ).not.toThrow();
    });

    it('constructs successfully for a valid production config', () => {
      expect(
        () => new MailtrapEmailConnector(productionConfig),
      ).not.toThrow();
    });
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('hits the production endpoint when mode is "production"', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Hello',
        text: 'Hi',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://send.api.mailtrap.io/api/send');
    });

    it('hits the sandbox endpoint with inboxId in the path when mode is "sandbox"', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const conn = new MailtrapEmailConnector(sandboxConfig);

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Hello',
        text: 'Hi',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://sandbox.api.mailtrap.io/api/send/abc');
    });

    it('returns canonical EmailSendResult shape on 2xx with message_ids[0]', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({ message_ids: ['m1'] }),
      );

      const result = await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result).toMatchObject({
        success: true,
        status: 'sent',
        providerMessageId: 'm1',
      });
      expect(result.raw).toMatchObject({
        success: true,
        message_ids: ['m1'],
      });
    });

    it('sets Bearer auth header correctly', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'x',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer mt_test_123');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Accept).toBe('application/json');
    });

    it('hand-structures the wire body in snake_case with from/to objects', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
        text: 'Hi',
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
      expect(body.html).toBe('<p>Hi</p>');
      expect(body.text).toBe('Hi');
    });

    it('maps reply_to as a single object (not an array)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        replyTo: 'reply@example.com',
        subject: 'reply',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.reply_to).toEqual({ email: 'reply@example.com' });
    });

    it('forwards headers as a flat Record (not reshaped to an array)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

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
      expect(body.headers).toEqual({ 'X-Foo': '1', 'X-Bar': '2' });
    });

    it('applies snake_case casing transform to _passthrough.body keys before merge', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'template',
        html: '<p>{{name}}</p>',
        _passthrough: {
          body: {
            templateUuid: 'u1',
            templateVariables: { firstName: 'Alex' },
            customVariables: { a: 1 },
            category: 'transactional',
          },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      // Top-level fields are cased to snake_case; nested data-map keys
      // (template_variables / custom_variables) pass through VERBATIM.
      expect(body.template_uuid).toBe('u1');
      expect(body.template_variables).toEqual({ firstName: 'Alex' });
      expect(body.custom_variables).toEqual({ a: 1 });
      expect(body.category).toBe('transactional');
      expect(body.templateUuid).toBeUndefined();
      expect(body.customVariables).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // Attachments
    // -------------------------------------------------------------------------

    it('maps Buffer attachments to base64 content with type metadata', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const fileBuf = Buffer.from('PDF-BYTES');

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
        attachments: Array<Record<string, string>>;
      };
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]).toEqual({
        filename: 'report.pdf',
        content: fileBuf.toString('base64'),
        type: 'application/pdf',
      });
    });

    it('emits content_id and disposition: inline when attachment.contentId is set', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

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
          filename: 'logo.png',
          type: 'image/png',
          content_id: 'logo',
          disposition: 'inline',
        }),
      );
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 401 to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, { success: false, errors: ['Unauthorized'] }),
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

    it('maps 400 with a recipient-phrase error to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          success: false,
          errors: ["'to' field has invalid recipient"],
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
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toContain("'to' field has invalid recipient");
      }
    });

    it('maps 400 with a non-recipient error to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          success: false,
          errors: ['malformed body'],
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

    it('maps 422 with a "to.email" validation error to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(422, {
          success: false,
          errors: ['to.email must be a valid email address'],
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

    it('maps 429 to rate_limited', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(429, {
          success: false,
          errors: ['Too many requests'],
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
        errorResponse(500, {
          success: false,
          errors: ['Internal server error'],
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

    it('parses Retry-After header into cause.retryAfter and cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '120',
          errorBody: { success: false, errors: ['Too many requests'] },
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
      const byoFetch = vi.fn().mockResolvedValue(successResponse());
      const conn = new MailtrapEmailConnector({
        ...productionConfig,
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
    it('has id "mailtrap" and channelType EMAIL', () => {
      expect(connector.id).toBe('mailtrap');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('sends a JSON message with Bearer auth and returns { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        html: '<p>Hello!</p>',
        text: 'Hello!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://send.api.mailtrap.io/api/send');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer mt_test_123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.from).toEqual({ email: 'sender@example.com', name: 'Test Sender' });
      expect(body.to).toEqual([{ email: 'recipient@example.com' }]);
      expect(body.subject).toBe('Test Subject');
      expect(body.html).toBe('<p>Hello!</p>');
      expect(body.text).toBe('Hello!');

      expect(result).toEqual({
        id: 'mt-msg-123',
        date: expect.any(String),
      });
    });

    it('includes cc and bcc when provided', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test',
        html: '<p>Test</p>',
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      expect(body.cc).toEqual([{ email: 'cc@example.com' }]);
      expect(body.bcc).toEqual([{ email: 'bcc@example.com' }]);
    });

    it('maps attachments to Mailtrap format', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

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
        type: 'application/pdf',
      });
    });

    it('merges bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { to: ['recipient@example.com'], subject: 'Test', html: '<p>Test</p>' },
        { _passthrough: { body: { category: 'transactional' } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.category).toBe('transactional');
    });

    it('throws ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, errors: ['Invalid API token'] }),
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
        // Brownfield now routes through canonical mapMailtrapErrorToProviderCode
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Invalid API token');
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
