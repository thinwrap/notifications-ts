import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { BrevoEmailConnector } from './brevo.connector';
import type { BrevoConfig } from './brevo.config';
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

const defaultConfig: BrevoConfig = {
  apiKey: 'xkeysib-test-123',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function brevoSuccessResponse(messageId = '<brevo-msg-123@example.com>'): Response {
  return new Response(JSON.stringify({ messageId }), { status: 201 });
}

function brevoErrorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('BrevoEmailConnector', () => {
  let connector: BrevoEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new BrevoEmailConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    // -------------------------------------------------------------------------
    // contentId pre-flight guard (canonical unsupported-feature
    // throw — THE most important assertion in this spec).
    // -------------------------------------------------------------------------

    it('throws ConnectorError pre-flight when any attachment has contentId set; fetch is NOT called', async () => {
      await expect(
        connector.send({
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 'inline cid',
          html: '<p><img src="cid:logo"></p>',
          attachments: [
            {
              filename: 'logo.png',
              contentType: 'image/png',
              content: Buffer.from('fake-png-bytes'),
              contentId: 'logo',
            },
          ],
        }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
        statusCode: 0,
      });

      // Critical: the guard is PRE-flight. Prove fetch was not invoked.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('the throw carries a message identifying Brevo and pointing to alternatives', async () => {
      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 's',
          html: '<p>',
          attachments: [
            {
              filename: 'logo.png',
              content: Buffer.from('fake'),
              contentId: 'logo',
            },
          ],
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.message).toMatch(/Brevo does not support attachment contentId/);
        expect(e.providerMessage).toMatch(/Brevo does not support inline cid/);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does NOT throw when attachments have contentId: undefined (guard is opt-in to throw only on truthy contentId)', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'plain attachment',
        html: '<p>see attached</p>',
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('PDF-BYTES'),
            // contentId omitted entirely
          },
        ],
      });

      expect(mockFetch).toHaveBeenCalledOnce();
    });

    // -------------------------------------------------------------------------
    // Happy path body shape
    // -------------------------------------------------------------------------

    it('sends a simple message and returns the canonical EmailSendResult shape on 201 Created', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse('msg_1'));

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
        providerMessageId: 'msg_1',
        raw: { messageId: 'msg_1' },
      });
    });

    it('POSTs to https://api.brevo.com/v3/smtp/email with api-key header (NOT Authorization)', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 's',
        text: 't',
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.brevo.com/v3/smtp/email');
      expect(reqInit.method).toBe('POST');

      const headers = reqInit.headers as Record<string, string>;
      expect(headers['api-key']).toBe('xkeysib-test-123');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Accept).toBe('application/json');
      // Critical: Brevo uses a CUSTOM header, NOT Bearer.
      expect(headers.Authorization).toBeUndefined();
    });

    it('hand-maps field renames: from→sender, html→htmlContent, text→textContent, attachments→attachment (singular)', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      const fileBuf = Buffer.from('PDF-CONTENT-BYTES');
      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'rename map',
        html: '<p>html body</p>',
        text: 'text body',
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: fileBuf,
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      // from → sender
      expect(body.sender).toEqual({
        name: 'Test Sender',
        email: 'sender@example.com',
      });
      // to → [{ email }]
      expect(body.to).toEqual([{ email: 'recipient@example.com' }]);
      // html → htmlContent
      expect(body.htmlContent).toBe('<p>html body</p>');
      // text → textContent
      expect(body.textContent).toBe('text body');
      // attachments → attachment (singular!)
      expect(body.attachments).toBeUndefined();
      expect(body.attachment).toEqual([
        { name: 'report.pdf', content: fileBuf.toString('base64') },
      ]);
    });

    it('encodes non-ASCII string attachment content as UTF-8 base64 (café ☕)', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      const text = 'café ☕ — résumé';
      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'utf8 attach',
        text: 'text body',
        attachments: [
          { filename: 'note.txt', contentType: 'text/plain', content: text },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        attachment: Array<Record<string, string>>;
      };
      expect(body.attachment[0]!.content).toBe(
        Buffer.from(text, 'utf-8').toString('base64'),
      );
      // Round-trips back to the original UTF-8 text (not corrupted latin1).
      expect(
        Buffer.from(body.attachment[0]!.content!, 'base64').toString('utf-8'),
      ).toBe(text);
    });

    it('uses bare email sender object when senderName is not configured', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());
      const conn = new BrevoEmailConnector({
        ...defaultConfig,
        senderName: undefined,
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 's',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.sender).toEqual({ email: 'sender@example.com' });
    });

    it('includes cc, bcc, and replyTo when provided', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
        subject: 'cc/bcc',
        html: '<p>x</p>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      expect(body.cc).toEqual([{ email: 'cc@example.com' }]);
      expect(body.bcc).toEqual([{ email: 'bcc@example.com' }]);
      expect(body.replyTo).toEqual({ email: 'reply@example.com' });
    });

    it('forwards headers and tags when provided', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 's',
        text: 't',
        headers: { 'X-Foo': '1' },
        tags: ['transactional', 'welcome'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.headers).toEqual({ 'X-Foo': '1' });
      expect(body.tags).toEqual(['transactional', 'welcome']);
    });

    // -------------------------------------------------------------------------
    // _passthrough merge — Brevo wire is camelCase, so passthrough.body is
    // forwarded VERBATIM (no casing transform).
    // -------------------------------------------------------------------------

    it('forwards _passthrough.body verbatim WITHOUT casing transform (Brevo wire is already camelCase)', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'template',
        _passthrough: {
          body: { templateId: 5, params: { firstName: 'Alex' } },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

      // Verbatim — camelCase keys preserved (NOT snake_case template_id).
      expect(body.templateId).toBe(5);
      expect(body.template_id).toBeUndefined();
      expect(body.params).toEqual({ firstName: 'Alex' });
    });

    it('forwards _passthrough.headers verbatim onto the fetch call', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

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
      expect(headers['api-key']).toBe('xkeysib-test-123');
    });

    it('folds _passthrough.query into the URL', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'q',
        text: 't',
        _passthrough: { query: { trace: 'on' } },
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.brevo.com/v3/smtp/email?trace=on');
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 401 unauthorized to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        brevoErrorResponse(401, { code: 'unauthorized', message: 'Key not found' }),
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
        expect(e.providerMessage).toBe('Key not found');
      }
    });

    it('maps 402 credit_exhausted to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        brevoErrorResponse(402, { code: 'credit_exhausted', message: 'Insufficient credits' }),
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
        expect(e.statusCode).toBe(402);
        expect(e.providerCode).toBe('auth_failed');
      }
    });

    it('maps 400 with recipient-pattern message to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        brevoErrorResponse(400, {
          code: 'invalid_parameter',
          message: 'Invalid email address in recipient',
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
      }
    });

    it('maps 400 with non-recipient message to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        brevoErrorResponse(400, {
          code: 'missing_parameter',
          message: 'Subject is required',
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
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('maps 429 to rate_limited', async () => {
      mockFetch.mockResolvedValueOnce(
        brevoErrorResponse(429, {
          code: 'too_many_requests',
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

    it('maps 500 to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        brevoErrorResponse(500, {
          code: 'unavailable',
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

    // -------------------------------------------------------------------------
    // Retry-After parsing
    // -------------------------------------------------------------------------

    it('parses integer Retry-After header into cause.retryAfter and cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '120',
          errorBody: { code: 'too_many_requests', message: 'Too many requests' },
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
      const byoFetch = vi.fn().mockResolvedValue(brevoSuccessResponse());
      const conn = new BrevoEmailConnector({
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
    it('should have id "brevo" and channelType EMAIL', () => {
      expect(connector.id).toBe('brevo');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('should send a JSON message with api-key header and return { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse('<brevo-msg-123@example.com>'));

      const result = await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        html: '<p>Hello!</p>',
        text: 'Hello!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.brevo.com/v3/smtp/email');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          'api-key': 'xkeysib-test-123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.sender).toEqual({ name: 'Test Sender', email: 'sender@example.com' });
      expect(body.to).toEqual([{ email: 'recipient@example.com' }]);
      expect(body.subject).toBe('Test Subject');
      expect(body.htmlContent).toBe('<p>Hello!</p>');
      expect(body.textContent).toBe('Hello!');

      expect(result).toEqual({
        id: '<brevo-msg-123@example.com>',
        date: expect.any(String),
      });
    });

    it('should include cc, bcc, and replyTo when provided', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

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
      expect(body.replyTo).toEqual({ email: 'reply@example.com' });
    });

    it('should map attachments to Brevo format', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

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
      const attachment = body.attachment as Array<Record<string, string>>;

      expect(attachment).toHaveLength(1);
      expect(attachment[0]).toEqual({
        name: 'report.pdf',
        content: fileBuffer.toString('base64'),
      });
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(brevoSuccessResponse());

      await connector.sendMessage(
        { to: ['recipient@example.com'], subject: 'Test', html: '<p>Test</p>' },
        { _passthrough: { body: { tags: ['transactional'] } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.tags).toEqual(['transactional']);
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 }),
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
        // Brownfield now routes through canonical mapBrevoErrorToProviderCode
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Key not found');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
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
