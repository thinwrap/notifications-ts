import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MailgunEmailConnector } from './mailgun.connector';
import type { MailgunConfig } from './mailgun.config';
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

const defaultConfig: MailgunConfig = {
  apiKey: 'key-test123',
  domain: 'mg.example.com',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function mailgunSuccessResponse(id = '<20230101120000.abc@mg.example.com>') {
  return new Response(
    JSON.stringify({ id, message: 'Queued. Thank you.' }),
    { status: 200 },
  );
}

function mailgunErrorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('MailgunEmailConnector', () => {
  let connector: MailgunEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new MailgunEmailConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('defaults to the US endpoint when region is omitted', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://api.mailgun.net/v3/mg.example.com/messages',
      );
    });

    it('routes to the EU endpoint when region: "eu" is set', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());
      const eu = new MailgunEmailConnector({ ...defaultConfig, region: 'eu' });

      await eu.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://api.eu.mailgun.net/v3/mg.example.com/messages',
      );
    });

    it('lets baseUrl override region (escape hatch for self-hosted Mailgun)', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());
      const local = new MailgunEmailConnector({
        ...defaultConfig,
        region: 'eu',
        baseUrl: 'https://example.local',
      });

      await local.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://example.local/v3/mg.example.com/messages',
      );
    });

    it('authenticates with HTTP Basic using api:<apiKey>', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        text: 'hi',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      const expectedAuth = Buffer.from('api:key-test123').toString('base64');
      expect(headers.Authorization).toBe(`Basic ${expectedAuth}`);
    });

    it('sends form-encoded body with no attachments', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      const result = await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>Hi!</p>',
        text: 'hi',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      const headers = reqInit.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('from')).toBe('Test Sender <sender@example.com>');
      expect(params.get('to')).toBe('recipient@example.com');
      expect(params.get('subject')).toBe('Hello');
      expect(params.get('html')).toBe('<p>Hi!</p>');
      expect(params.get('text')).toBe('hi');

      expect(result).toEqual({
        success: true,
        status: 'queued',
        providerMessageId: '<20230101120000.abc@mg.example.com>',
        raw: {
          id: '<20230101120000.abc@mg.example.com>',
          message: 'Queued. Thank you.',
        },
      });
    });

    it('sends multipart/form-data body when attachments are present', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      const fileBuffer = Buffer.from('PDF-CONTENT-BYTES');
      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Attachment Test',
        html: '<p>See attached</p>',
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: fileBuffer,
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const headers = reqInit.headers as Record<string, string>;
      expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);

      const bodyStr = (reqInit.body as Buffer).toString();
      expect(bodyStr).toContain('Content-Disposition: form-data; name="from"');
      expect(bodyStr).toContain(
        'Content-Disposition: form-data; name="attachment"; filename="report.pdf"',
      );
      expect(bodyStr).toContain('Content-Type: application/pdf');
    });

    it('uses name="inline" for cid-referenced attachments', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Inline image',
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
      const bodyStr = ((init as RequestInit).body as Buffer).toString();
      expect(bodyStr).toContain(
        'Content-Disposition: form-data; name="inline"; filename="logo.png"',
      );
    });

    it('includes h:Reply-To when replyTo is provided', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Reply',
        text: 'plain',
        replyTo: 'r@x.com',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('h:Reply-To')).toBe('r@x.com');
    });

    it('emits h:<HeaderName> form fields for each custom header', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Headers',
        text: 'plain',
        headers: { 'X-Trace-Id': 't-1', 'X-Custom': 'v' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('h:X-Trace-Id')).toBe('t-1');
      expect(params.get('h:X-Custom')).toBe('v');
    });

    it('truncates tags to the first 3 and emits them as repeated o:tag fields', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Tags',
        text: 'plain',
        tags: ['a', 'b', 'c', 'd'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.getAll('o:tag')).toEqual(['a', 'b', 'c']);
    });

    it('joins multiple to/cc/bcc addresses with commas', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
        subject: 'CC/BCC',
        text: 'plain',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('cc')).toBe('cc1@example.com,cc2@example.com');
      expect(params.get('bcc')).toBe('bcc@example.com');
    });

    it('merges _passthrough.body into the form-encoded body', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Passthrough',
        text: 'plain',
        _passthrough: { body: { 'v:campaign': 'spring' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('v:campaign')).toBe('spring');
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 401 to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        mailgunErrorResponse(401, { message: 'Forbidden' }),
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
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('Forbidden');
      }
    });

    it('maps 402 Payment Required to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        mailgunErrorResponse(402, { message: 'Request Failed - Payment Required' }),
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

    it('maps 400 with "not a valid email" message to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        mailgunErrorResponse(400, {
          message: "'bad@@x' is not a valid email address",
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'bad@@x',
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

    it('maps generic 400 to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        mailgunErrorResponse(400, { message: 'Need at least one of html or text' }),
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

    it('maps 404 Unknown domain to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        mailgunErrorResponse(404, { message: 'Domain not found: mg.example.com' }),
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
        expect(e.statusCode).toBe(404);
        expect(e.providerCode).toBe('invalid_request');
      }
    });

    it('maps 429 Too Many Requests to rate_limited', async () => {
      mockFetch.mockResolvedValueOnce(
        mailgunErrorResponse(429, { message: 'Too Many Requests' }),
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

    it('maps 5xx to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        mailgunErrorResponse(500, { message: 'Internal Server Error' }),
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

    it('parses Retry-After header into cause.retryAfter and cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { message: 'Too Many Requests' },
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
        expect(e.providerMessage).toBe('Too Many Requests');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('has id "mailgun" and channelType EMAIL', () => {
      expect(connector.id).toBe('mailgun');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('sends form-encoded message with Basic auth to correct URL', async () => {
      mockFetch.mockResolvedValueOnce(mailgunSuccessResponse());

      const result = await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        html: '<p>Hello!</p>',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://api.mailgun.net/v3/mg.example.com/messages');

      const expectedAuth = Buffer.from('api:key-test123').toString('base64');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${expectedAuth}`,
        }),
      );

      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('from')).toBe('Test Sender <sender@example.com>');
      expect(params.get('to')).toBe('recipient@example.com');
      expect(params.get('subject')).toBe('Test Subject');
      expect(params.get('html')).toBe('<p>Hello!</p>');

      expect(result).toEqual({
        id: '<20230101120000.abc@mg.example.com>',
        date: expect.any(String),
      });
    });

    it('throws ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Forbidden' }), { status: 401 }),
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
        expect(connectorErr.providerMessage).toBe('Forbidden');
      }
    });
  });
});
