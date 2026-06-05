import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { SparkPostEmailConnector } from './sparkpost.connector';
import type { SparkPostConfig } from './sparkpost.config';
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

const defaultConfig: SparkPostConfig = {
  apiKey: 'sp-test-key-123',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function successResponse(
  overrides: Partial<{
    id: string;
    total_accepted_recipients: number;
    total_rejected_recipients: number;
  }> = {},
): Response {
  return new Response(
    JSON.stringify({
      results: {
        id: overrides.id ?? 'sp-msg-123',
        total_accepted_recipients: overrides.total_accepted_recipients ?? 1,
        total_rejected_recipients: overrides.total_rejected_recipients ?? 0,
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

describe('SparkPostEmailConnector', () => {
  let connector: SparkPostEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new SparkPostEmailConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    // -------------------------------------------------------------------------
    // CANONICAL TEST — CC/BCC outlier translation
    // -------------------------------------------------------------------------

    it('translates cc and bcc into recipients[].header_to with content.headers.CC for visibility (canonical)', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({ total_accepted_recipients: 3 }),
      );

      await connector.send({
        from: 'sender@example.com',
        to: 'a@x',
        cc: ['c@y'],
        bcc: ['b@z'],
        subject: 'S',
        html: '<p>Hi</p>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;

      expect(body.recipients).toEqual([
        { address: { email: 'a@x' } },
        { address: { email: 'c@y', header_to: 'a@x' } },
        { address: { email: 'b@z', header_to: 'a@x' } },
      ]);

      const content = body.content as Record<string, unknown>;
      const headers = content.headers as Record<string, string>;
      expect(headers.CC).toBe('c@y');
      // BCC stays invisible — never written to content.headers.
      expect(headers.BCC).toBeUndefined();
    });

    it('CC only (no BCC): comma-joins cc list into content.headers.CC', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({ total_accepted_recipients: 3 }),
      );

      await connector.send({
        from: 'sender@example.com',
        to: 'a@x',
        cc: ['c1@y', 'c2@y'],
        subject: 'S',
        html: '<p>Hi</p>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;

      expect(body.recipients).toEqual([
        { address: { email: 'a@x' } },
        { address: { email: 'c1@y', header_to: 'a@x' } },
        { address: { email: 'c2@y', header_to: 'a@x' } },
      ]);

      const content = body.content as Record<string, unknown>;
      const headers = content.headers as Record<string, string>;
      expect(headers.CC).toBe('c1@y, c2@y');
    });

    it('no cc/bcc: recipients has a single entry and content.headers is absent', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'a@x',
        subject: 'S',
        html: '<p>Hi</p>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;

      expect(body.recipients).toEqual([{ address: { email: 'a@x' } }]);

      const content = body.content as Record<string, unknown>;
      expect(content.headers).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // Attachments routing
    // -------------------------------------------------------------------------

    it('routes attachments with contentId to inline_images and others to attachments', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const docBuf = Buffer.from('PDF-BYTES');
      const imgBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'attach',
        html: '<p><img src="cid:logo"></p>',
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: docBuf,
          },
          {
            filename: 'logo.png',
            contentType: 'image/png',
            content: imgBuf,
            contentId: 'logo',
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      const content = body.content as Record<string, unknown>;
      const attachments = content.attachments as Array<Record<string, string>>;
      const inlineImages = content.inline_images as Array<Record<string, string>>;

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual({
        name: 'report.pdf',
        type: 'application/pdf',
        data: docBuf.toString('base64'),
      });

      expect(inlineImages).toHaveLength(1);
      expect(inlineImages[0]).toEqual({
        name: 'logo.png',
        type: 'image/png',
        data: imgBuf.toString('base64'),
      });
    });

    // -------------------------------------------------------------------------
    // Endpoint resolution
    // -------------------------------------------------------------------------

    it('hits the US endpoint when region is omitted', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'x',
        text: 't',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.sparkpost.com/api/v1/transmissions');
    });

    it('hits the EU endpoint when region is "eu"', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const euConnector = new SparkPostEmailConnector({
        ...defaultConfig,
        region: 'eu',
      });

      await euConnector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'x',
        text: 't',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.eu.sparkpost.com/api/v1/transmissions');
    });

    // -------------------------------------------------------------------------
    // Auth
    // -------------------------------------------------------------------------

    it('sends the raw API key as the Authorization header (no Bearer prefix)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'x',
        text: 't',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('sp-test-key-123');
      expect(headers.Authorization!.startsWith('Bearer')).toBe(false);
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Accept).toBe('application/json');
    });

    // -------------------------------------------------------------------------
    // Happy-path result shape
    // -------------------------------------------------------------------------

    it('returns canonical EmailSendResult shape on 200 with results.id', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({
          id: 'tx_1',
          total_accepted_recipients: 1,
          total_rejected_recipients: 0,
        }),
      );

      const result = await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result).toMatchObject({
        success: true,
        status: 'queued',
        providerMessageId: 'tx_1',
      });
      expect(result.raw).toMatchObject({
        results: {
          id: 'tx_1',
          total_accepted_recipients: 1,
          total_rejected_recipients: 0,
        },
      });
    });

    // -------------------------------------------------------------------------
    // 200 with all recipients rejected
    // -------------------------------------------------------------------------

    it('throws ConnectorError invalid_recipient when 200 reports total_accepted_recipients=0', async () => {
      mockFetch.mockResolvedValueOnce(
        successResponse({
          total_accepted_recipients: 0,
          total_rejected_recipients: 1,
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'bad@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(200);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toContain('total_rejected_recipients=1');
      }
    });

    // -------------------------------------------------------------------------
    // Casing transform
    // -------------------------------------------------------------------------

    it('applies snake_case casing transform to _passthrough.body keys before merge', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'campaign',
        html: '<p>{{name}}</p>',
        _passthrough: {
          body: {
            campaignId: 'c1',
            substitutionData: { firstName: 'Alex' },
            metadata: { customerId: 'u-42' },
          },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.campaign_id).toBe('c1');
      expect(body.substitution_data).toEqual({ first_name: 'Alex' });
      expect(body.metadata).toEqual({ customer_id: 'u-42' });
      expect(body.campaignId).toBeUndefined();
      expect(body.substitutionData).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 401 to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, { errors: [{ message: 'Unauthorized' }] }),
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

    it('maps 400 with recipient-phrase to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          errors: [{ message: 'Invalid recipient address' }],
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
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toContain('Invalid recipient address');
      }
    });

    it('maps 400 with recipient error code (1300) to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          errors: [{ code: '1300', message: 'No valid recipients' }],
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
        expect(e.providerCode).toBe('invalid_recipient');
      }
    });

    it('maps 400 with other malformed error to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, {
          errors: [{ message: 'malformed body' }],
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

    it('maps 422 to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(422, {
          errors: [{ message: 'Validation failed' }],
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
        errorResponse(429, { errors: [{ message: 'Too many requests' }] }),
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
        errorResponse(500, { errors: [{ message: 'Internal server error' }] }),
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
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('should have id "sparkpost" and channelType EMAIL', () => {
      expect(connector.id).toBe('sparkpost');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('should send a JSON message with raw API key Authorization and return { id, date }', async () => {
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

      expect(url).toBe('https://api.sparkpost.com/api/v1/transmissions');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'sp-test-key-123',
        }),
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.recipients).toEqual([
        { address: { email: 'recipient@example.com' } },
      ]);

      const content = body.content as Record<string, unknown>;
      expect(content.from).toEqual({ email: 'sender@example.com', name: 'Test Sender' });
      expect(content.subject).toBe('Test Subject');
      expect(content.html).toBe('<p>Hello!</p>');
      expect(content.text).toBe('Hello!');

      expect(result).toEqual({
        id: 'sp-msg-123',
        date: expect.any(String),
      });
    });

    it('should use EU endpoint when region is "eu"', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const euConnector = new SparkPostEmailConnector({
        ...defaultConfig,
        region: 'eu',
      });

      await euConnector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test',
        html: '<p>Test</p>',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.eu.sparkpost.com/api/v1/transmissions');
    });

    it('should include cc and bcc as additional recipients', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

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
      const recipients = body.recipients as Array<Record<string, unknown>>;

      expect(recipients).toEqual([
        { address: { email: 'recipient@example.com' } },
        { address: { email: 'cc@example.com' } },
        { address: { email: 'bcc@example.com' } },
      ]);

      const content = body.content as Record<string, unknown>;
      expect(content.reply_to).toBe('reply@example.com');
    });

    it('should map attachments to SparkPost format', async () => {
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
      const content = body.content as Record<string, unknown>;
      const attachments = content.attachments as Array<Record<string, string>>;

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual({
        name: 'report.pdf',
        type: 'application/pdf',
        data: fileBuffer.toString('base64'),
      });
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { to: ['recipient@example.com'], subject: 'Test', html: '<p>Test</p>' },
        { _passthrough: { body: { options: { open_tracking: true } } } },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.options).toEqual({ open_tracking: true });
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ code: '1902', message: 'Forbidden' }] }), { status: 403 }),
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
        expect(connectorErr.statusCode).toBe(403);
        // Brownfield now routes through canonical mapSparkPostErrorToProviderCode
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Forbidden');
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
