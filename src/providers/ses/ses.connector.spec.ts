import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { SesEmailConnector } from './ses.connector';
import type { SesConfig } from './ses.config';
import { ChannelTypeEnum, CheckIntegrationResponseEnum } from '../../types';
import { ConnectorError } from '../../utils';
import { createRetryAfterFixture } from '../../test-utils';

const mockFetch = vi.fn();

beforeAll(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: SesConfig = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function sesSuccessResponse(messageId = 'ses-msg-123') {
  return new Response(JSON.stringify({ MessageId: messageId }), { status: 200 });
}

function sesErrorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('SesEmailConnector', () => {
  let connector: SesEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.clearAllMocks();
    connector = new SesEmailConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('sends a simple message and returns the canonical EmailSendResult shape', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse('abc-123'));

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
        providerMessageId: 'abc-123',
        raw: { MessageId: 'abc-123' },
      });

      // URL + method
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      expect(url).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');
      expect(reqInit.method).toBe('POST');

      // Body shape — Content.Simple path
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        FromEmailAddress: 'Test Sender <sender@example.com>',
        Destination: { ToAddresses: ['recipient@example.com'] },
        Content: {
          Simple: {
            Subject: { Data: 'Hello', Charset: 'UTF-8' },
            Body: {
              Html: { Data: '<p>Hi!</p>', Charset: 'UTF-8' },
              Text: { Data: 'Hi!', Charset: 'UTF-8' },
            },
          },
        },
      });

      // Sig V4 signing (hand-rolled) — real signed headers on the fetch call
      const headers = reqInit.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
      );
      expect(headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
      expect(headers['X-Amz-Content-Sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(headers.Host).toBe('email.us-east-1.amazonaws.com');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('omits senderName from FromEmailAddress when not set on config', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      const conn = new SesEmailConnector({ ...defaultConfig, senderName: undefined });

      await conn.send({
        from: 'sender@example.com',
        to: 'rcp@example.com',
        subject: 'Hi',
        text: 'plain',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.FromEmailAddress).toBe('sender@example.com');
    });

    it('includes CcAddresses, BccAddresses, ReplyToAddresses when provided', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
        subject: 'CC/BCC Test',
        html: '<p>Body</p>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        Record<string, unknown>
      >;
      expect(body.Destination).toBeDefined();
      expect(body.Destination!.CcAddresses).toEqual(['cc1@example.com', 'cc2@example.com']);
      expect(body.Destination!.BccAddresses).toEqual(['bcc@example.com']);
      expect(body.ReplyToAddresses).toEqual(['reply@example.com']);
    });

    it('builds a MIME multipart body for attachments and submits as Content.Raw.Data', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      const fileBuf = Buffer.from('PDF-CONTENT-BYTES');

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
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
        Content: { Raw?: { Data: string }; Simple?: unknown };
      };
      expect(body.Content.Raw).toBeDefined();
      expect(body.Content.Simple).toBeUndefined();

      const decoded = Buffer.from(body.Content.Raw!.Data, 'base64').toString('utf-8');
      expect(decoded).toContain('MIME-Version: 1.0');
      expect(decoded).toContain('Content-Type: multipart/mixed');
      expect(decoded).toContain('Content-Type: application/pdf; name="report.pdf"');
      expect(decoded).toContain('Content-Disposition: attachment; filename="report.pdf"');
      expect(decoded).toContain('Content-Transfer-Encoding: base64');
      expect(decoded).toContain(fileBuf.toString('base64'));
    });

    it('RFC 2047-encodes only the non-ASCII sender display name, keeping a bare addr-spec in From', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      // Attachments force the Raw-MIME path where From is hand-built.
      const conn = new SesEmailConnector({
        ...defaultConfig,
        senderName: 'Café ☕ Señor',
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Attachment Test',
        html: '<p>hi</p>',
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('PDF'),
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        Content: { Raw: { Data: string } };
      };
      const decoded = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf-8');

      const fromLine = decoded
        .split('\r\n')
        .find((l) => l.startsWith('From: '));
      expect(fromLine).toBeDefined();
      // addr-spec stays bare and parseable — NOT swallowed into an encoded-word.
      expect(fromLine).toMatch(
        /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <sender@example\.com>$/,
      );
      expect(decoded).toContain('<sender@example.com>');
    });

    it('encodes string-typed attachment content as UTF-8 base64', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'String attach',
        text: 'plain',
        attachments: [
          {
            filename: 'note.txt',
            contentType: 'text/plain',
            content: 'hello',
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        Content: { Raw: { Data: string } };
      };
      const decoded = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf-8');
      expect(decoded).toContain(Buffer.from('hello', 'utf-8').toString('base64'));
    });

    it('preserves non-ASCII body content as UTF-8 in the Raw MIME (café ☕)', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      // Attachments force the Raw-MIME path (the whole message is base64'd).
      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Ünïcödé ☕',
        html: '<p>Prix: 5€ — café ☕</p>',
        text: 'Prix: 5€ — café ☕',
        attachments: [
          { filename: 'a.txt', contentType: 'text/plain', content: 'x' },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        Content: { Raw: { Data: string } };
      };
      const decoded = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf-8');

      // Body parts are base64 (7-bit-safe), never 8bit/7bit.
      expect(decoded).toContain('Content-Type: text/plain; charset=UTF-8');
      expect(decoded).toContain('Content-Transfer-Encoding: base64');
      expect(decoded).not.toContain('Content-Transfer-Encoding: 8bit');
      expect(decoded).not.toContain('Content-Transfer-Encoding: 7bit');
      // The é/€/☕ must survive intact: decode each base64 body part and confirm.
      const decodedParts = decoded
        .split(/\r\n/)
        .filter((l) => /^[A-Za-z0-9+/=]+$/.test(l) && l.length > 8)
        .map((l) => Buffer.from(l, 'base64').toString('utf-8'))
        .join('');
      expect(decodedParts).toContain('Prix: 5€ — café ☕');
    });

    it('wraps attachment base64 at 76-char lines (RFC 2045/5322 conformance)', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      // >740 bytes: the base64 would exceed a single conformant line if unwrapped.
      const big = Buffer.alloc(2000, 0x41);
      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'big attach',
        text: 'body',
        attachments: [
          {
            filename: 'big.bin',
            contentType: 'application/octet-stream',
            content: big,
          },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as {
        Content: { Raw: { Data: string } };
      };
      const decoded = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf-8');

      const b64 = big.toString('base64');
      // The unwrapped single-line payload must NOT appear — it was soft-wrapped.
      expect(decoded).not.toContain(b64);
      // The CRLF-wrapped 76-char form must appear verbatim.
      const wrapped = (b64.match(/.{1,76}/g) ?? []).join('\r\n');
      expect(decoded).toContain(wrapped);
      // Every base64 body line is <= 76 chars.
      const b64Lines = decoded
        .split('\r\n')
        .filter((l) => /^[A-Za-z0-9+/]+={0,2}$/.test(l) && l.length > 20);
      expect(b64Lines.length).toBeGreaterThan(1);
      for (const line of b64Lines) {
        expect(line.length).toBeLessThanOrEqual(76);
      }
    });

    it('emits Content-ID/inline disposition when attachment.contentId is set', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
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
      const body = JSON.parse((init as RequestInit).body as string) as {
        Content: { Raw: { Data: string } };
      };
      const decoded = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf-8');
      expect(decoded).toContain('Content-ID: <logo>');
      expect(decoded).toContain('Content-Disposition: inline; filename="logo.png"');
    });

    it('includes ConfigurationSetName from config when set', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      const conn = new SesEmailConnector({
        ...defaultConfig,
        configurationSetName: 'my-set',
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'cfg-set',
        text: 'plain',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.ConfigurationSetName).toBe('my-set');
    });

    it('lets per-send configurationSetName override config', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      const conn = new SesEmailConnector({
        ...defaultConfig,
        configurationSetName: 'config-default',
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'per-send override',
        text: 'plain',
        configurationSetName: 'override-set',
      } as never);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.ConfigurationSetName).toBe('override-set');
    });

    it('propagates SES-narrowed input fields (sourceArn, returnPath, tags) to the wire body', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'narrowed',
        text: 'plain',
        sourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/example.com',
        returnPath: 'bounce@example.com',
        tags: [
          { Name: 'campaign', Value: 'spring' },
          { Name: 'env', Value: 'prod' },
        ],
      } as never);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.FromEmailAddressIdentityArn).toBe(
        'arn:aws:ses:us-east-1:123456789012:identity/example.com',
      );
      expect(body.ReturnPath).toBe('bounce@example.com');
      expect(body.EmailTags).toEqual([
        { Name: 'campaign', Value: 'spring' },
        { Name: 'env', Value: 'prod' },
      ]);
    });

    it('signs and sends X-Amz-Security-Token when config has a sessionToken (STS)', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      const conn = new SesEmailConnector({
        ...defaultConfig,
        sessionToken: 'sts-session-token-value',
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'sts',
        text: 'plain',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['X-Amz-Security-Token']).toBe('sts-session-token-value');
      // The token must participate in the signature, not just ride along.
      expect(headers.Authorization).toContain('x-amz-security-token');
    });

    // -------------------------------------------------------------------------
    // _passthrough forwarding
    // -------------------------------------------------------------------------

    it('merges _passthrough.body into the signed request body and headers into the request', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Passthrough',
        text: 'plain',
        _passthrough: {
          body: { EmailTags: [{ Name: 'campaign', Value: 'spring' }] },
          headers: { 'X-Custom': 'v' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.EmailTags).toEqual([{ Name: 'campaign', Value: 'spring' }]);

      // Custom header lands on the request AND participates in the signature.
      const headers = reqInit.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('v');
      expect(headers.Authorization).toContain('x-custom');
    });

    it('sends but does NOT sign hop-by-hop / runtime-owned passthrough headers', async () => {
      // Per the AWS signing guide ("Do not include hop-by-hop headers ...");
      // signing these invites SignatureDoesNotMatch when a proxy or the fetch
      // runtime rewrites them after signing.
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Unsignable',
        text: 'plain',
        _passthrough: {
          headers: { 'User-Agent': 'consumer-ua/1.0', 'X-Custom': 'v' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['User-Agent']).toBe('consumer-ua/1.0'); // on the wire
      expect(headers.Authorization).not.toContain('user-agent'); // not signed
      expect(headers.Authorization).toContain('x-custom'); // normal ones still are
    });

    it('folds _passthrough.query into the signed path so the signature remains valid', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Query',
        text: 'plain',
        _passthrough: { query: { trace: 'on' } },
      });

      // The query must land on the request URL; the deterministic-signature
      // test below pins that the same canonical query is covered by Sig V4.
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails?trace=on',
      );
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 400 MessageRejected to invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(400, {
          __type: 'MessageRejected',
          message: 'Email address is on the suppression list',
        }),
      );

      try {
        await connector.send({
          from: 'sender@example.com',
          to: 'suppressed@example.com',
          subject: 'x',
          text: 't',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toBe('Email address is on the suppression list');
      }
    });

    it('maps 403 SignatureDoesNotMatch to auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(403, {
          __type: 'SignatureDoesNotMatch',
          message: 'The request signature we calculated does not match',
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

    it('maps 429 Throttling to rate_limited', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(429, {
          __type: 'ThrottlingException',
          message: 'Maximum sending rate exceeded',
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

    it('maps 5xx InternalFailure to provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(500, {
          __type: 'InternalFailure',
          message: 'We encountered an internal error',
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

    it('maps 400 ValidationException to invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(400, {
          __type: 'ValidationException',
          message: 'Missing required field: Destination',
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

    it('maps an unrecognized status (e.g. 418) to unknown', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(418, {
          __type: 'IAmATeapot',
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

    it('reads legacy `Code` / `Message` casing in error body (XML-translated path)', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(403, {
          Code: 'InvalidClientTokenId',
          Message: 'The security token is invalid',
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
        expect(e.providerMessage).toBe('The security token is invalid');
      }
    });

    // -------------------------------------------------------------------------
    // Retry-After parsing
    // -------------------------------------------------------------------------

    it('parses integer Retry-After header into cause.retryAfter (raw) + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '30',
          errorBody: { __type: 'Throttling', message: 'Slow down' },
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
        expect(e.providerMessage).toBe('Slow down');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '30',
          retryAfterSeconds: 30,
        });
      }
    });

    it('does not append Retry-After text when the header is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          errorBody: { __type: 'Throttling', message: 'Slow down' },
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
        expect(e.providerMessage).toBe('Slow down');
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

    it('returns providerMessageId = null when SES omits MessageId in 2xx body (defensive)', async () => {
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
  // Sig V4 signing — deterministic pinned vectors
  // ===========================================================================

  describe('Sig V4 signing (hand-rolled) — deterministic vectors', () => {
    // Signatures cross-verified byte-for-byte against two independent
    // implementations (when the `aws4` runtime dep was dropped):
    // `aws4@1.13.x` (doNotModifyHeaders + identical header set) and
    // `aws4fetch@1.0.20` (AwsV4Signer with allHeaders: true). Same fixed
    // timestamp, credentials, and body → same Authorization header from both.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('produces the cross-verified signature for a fixed request', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello',
        text: 'Hi!',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['X-Amz-Date']).toBe('20260516T000000Z');
      expect(headers['X-Amz-Content-Sha256']).toBe(
        'bf9e1517ed7c5b496525fa0a3e693a2309aec29c0c9f3258e4961b3dd29955a2',
      );
      expect(headers.Authorization).toBe(
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260516/us-east-1/ses/aws4_request, ' +
          'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
          'Signature=2a5397edea985f936e3b3e76521c92bced03480027c678aae7789ee2a35d37fd',
      );
    });

    it('produces the cross-verified signature with STS sessionToken', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      const conn = new SesEmailConnector({
        ...defaultConfig,
        senderName: undefined,
        sessionToken: 'sts-session-token-value',
      });

      await conn.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'sts',
        text: 'plain',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260516/us-east-1/ses/aws4_request, ' +
          'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, ' +
          'Signature=53ed96d4eb3bfb4f774ac686c1fc142d68930817a57ae2d776c49120eab25f49',
      );
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() / .checkIntegration() — preserved Novu surface', () => {
    it('has id "ses" and channelType EMAIL', () => {
      expect(connector.id).toBe('ses');
      expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
    });

    it('sends a simple message and returns { id, date }', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      const result = await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        html: '<p>Hello!</p>',
        text: 'Hello!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');

      const body = JSON.parse(reqInit.body as string);
      expect(body.Content).toHaveProperty('Simple');
      expect(body.Content.Simple.Subject).toEqual({ Data: 'Test Subject', Charset: 'UTF-8' });
      expect(body.Content.Simple.Body.Html).toEqual({ Data: '<p>Hello!</p>', Charset: 'UTF-8' });
      expect(body.Content.Simple.Body.Text).toEqual({ Data: 'Hello!', Charset: 'UTF-8' });
      expect(body.FromEmailAddress).toBe('Test Sender <sender@example.com>');
      expect(body.Destination.ToAddresses).toEqual(['recipient@example.com']);

      expect(result).toEqual({ id: 'ses-msg-123', date: expect.any(String) });
      expect(() => new Date(result.date!)).not.toThrow();
    });

    it('includes CcAddresses, BccAddresses, and ReplyToAddresses when provided', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'CC/BCC Test',
        html: '<p>Test</p>',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.Destination.CcAddresses).toEqual(['cc1@example.com', 'cc2@example.com']);
      expect(body.Destination.BccAddresses).toEqual(['bcc@example.com']);
      expect(body.ReplyToAddresses).toEqual(['reply@example.com']);
    });

    it('uses Content.Raw.Data (base64 MIME) when attachments are provided', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      const fileBuffer = Buffer.from('file-content-here');
      await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Attachment Test',
        html: '<p>See attached</p>',
        attachments: [{ mime: 'application/pdf', file: fileBuffer, name: 'report.pdf' }],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.Content).toHaveProperty('Raw');
      expect(body.Content).not.toHaveProperty('Simple');
      expect(typeof body.Content.Raw.Data).toBe('string');
      const decoded = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf-8');
      expect(decoded).toContain('MIME-Version: 1.0');
      expect(decoded).toContain('Content-Type: multipart/mixed');
      expect(decoded).toContain('Content-Type: application/pdf; name="report.pdf"');
      expect(decoded).toContain('Content-Transfer-Encoding: base64');
      expect(decoded).toContain(fileBuffer.toString('base64'));
    });

    it('merges bridgeProviderData passthrough body into the request', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.sendMessage(
        { to: ['recipient@example.com'], subject: 'Passthrough Test', html: '<p>Test</p>' },
        { _passthrough: { body: { FeedbackForwardingEmailAddress: 'feedback@example.com' } } }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.FeedbackForwardingEmailAddress).toBe('feedback@example.com');
      expect(body.FromEmailAddress).toBe('Test Sender <sender@example.com>');
      expect(body.Destination.ToAddresses).toEqual(['recipient@example.com']);
    });

    it('throws ConnectorError on API error (legacy 401 path)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ Code: 'InvalidClientTokenId', message: 'Invalid credentials' }),
          { status: 401 }
        )
      );

      try {
        await connector.sendMessage({
          to: ['recipient@example.com'],
          subject: 'Error Test',
          html: '<p>Test</p>',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.message).toBe('Invalid credentials');
        expect(connectorErr.statusCode).toBe(401);
        // Brownfield now routes through canonical mapSesErrorToProviderCode
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Invalid credentials');
      }
    });

    it('returns { success: true, code: SUCCESS } from checkIntegration on success', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      const result = await connector.checkIntegration({
        to: ['recipient@example.com'],
        subject: 'Integration Check',
        html: '<p>Test</p>',
      });

      expect(result).toEqual({
        success: true,
        message: 'Integration successful',
        code: CheckIntegrationResponseEnum.SUCCESS,
      });
    });

    it('returns { success: false, code: BAD_CREDENTIALS } from checkIntegration on 401', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ Code: 'InvalidClientTokenId', message: 'Invalid credentials' }),
          { status: 401 }
        )
      );

      const result = await connector.checkIntegration({
        to: ['recipient@example.com'],
        subject: 'Integration Check',
        html: '<p>Test</p>',
      });

      expect(result).toEqual({
        success: false,
        message: 'Invalid credentials',
        code: CheckIntegrationResponseEnum.BAD_CREDENTIALS,
      });
    });

    it('includes ConfigurationSetName when set in config', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      const connectorWithSet = new SesEmailConnector({ ...defaultConfig, configurationSetName: 'my-config-set' });

      await connectorWithSet.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Config Set Test',
        html: '<p>Test</p>',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.ConfigurationSetName).toBe('my-config-set');
    });

    it('uses senderName from options when overriding config default', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Sender Name Override Test',
        html: '<p>Test</p>',
        senderName: 'Override Sender',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.FromEmailAddress).toBe('Override Sender <sender@example.com>');
    });
  });
});
