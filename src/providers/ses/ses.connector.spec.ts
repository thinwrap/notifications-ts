import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { SesEmailConnector } from './ses.connector';
import { Email } from '../../facades/email.facade';
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

    // SES v2 model `Message.Attachments` (botocore 1.37.27): Attachment requires
    // RawContent + FileName; RawContent "needs to be base64-encoded if you are
    // accessing Amazon SES directly through the HTTPS interface";
    // ContentDisposition is ATTACHMENT | INLINE; ContentId is "used for
    // referencing attachments with INLINE disposition in HTML content".
    it('sends attachments through Content.Simple.Attachments (no raw MIME)', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      const pdf = Buffer.from('%PDF-1.4 fake');

      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 'Report',
        html: '<p>See attached <img src="cid:logo"></p>',
        text: 'See attached',
        attachments: [
          { filename: 'report.pdf', contentType: 'application/pdf', content: pdf },
          { filename: 'logo.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50]), contentId: 'logo' },
        ],
      });

      const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
        Content: { Simple?: Record<string, unknown>; Raw?: unknown };
      };
      expect(body.Content).not.toHaveProperty('Raw');
      expect(body.Content.Simple).toMatchObject({
        Subject: { Data: 'Report', Charset: 'UTF-8' },
        Body: {
          Html: { Data: '<p>See attached <img src="cid:logo"></p>', Charset: 'UTF-8' },
          Text: { Data: 'See attached', Charset: 'UTF-8' },
        },
      });
      expect(body.Content.Simple!.Attachments).toEqual([
        {
          FileName: 'report.pdf',
          RawContent: pdf.toString('base64'),
          ContentType: 'application/pdf',
          ContentDisposition: 'ATTACHMENT',
        },
        {
          FileName: 'logo.png',
          RawContent: Buffer.from([0x89, 0x50]).toString('base64'),
          ContentType: 'image/png',
          ContentDisposition: 'INLINE',
          ContentId: 'logo',
        },
      ]);
    });

    it('encodes string attachment content as UTF-8 base64 RawContent', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 's',
        text: 't',
        attachments: [{ filename: 'note.txt', content: 'café ☕' }],
      });
      const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
        Content: { Simple: { Attachments: Array<Record<string, unknown>> } };
      };
      const att = body.Content.Simple.Attachments[0]!;
      expect(Buffer.from(att.RawContent as string, 'base64').toString('utf8')).toBe('café ☕');
      expect(att).not.toHaveProperty('ContentType');
    });

    // SES developer guide (send-email-raw): a Unicode "friendly from" name must
    // use MIME encoded-word syntax; RFC 5322 requires a quoted-string for an
    // ASCII name with specials such as ",".
    it('FromEmailAddress: quotes an ASCII name with specials, encoded-words a non-ASCII one', async () => {
      mockFetch.mockImplementation(async () => sesSuccessResponse());

      await new SesEmailConnector({ ...defaultConfig, senderName: 'Acme, Inc.' }).send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 's',
        text: 't',
      });
      await new SesEmailConnector({ ...defaultConfig, senderName: 'Café Ünïcode' }).send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 's',
        text: 't',
      });

      const from1 = (JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
        FromEmailAddress: string;
      }).FromEmailAddress;
      const from2 = (JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string) as {
        FromEmailAddress: string;
      }).FromEmailAddress;
      expect(from1).toBe('"Acme, Inc." <sender@example.com>');
      expect(from2).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <sender@example\.com>$/);
      const word = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(from2)![1]!;
      expect(Buffer.from(word, 'base64').toString('utf8')).toBe('Café Ünïcode');
      mockFetch.mockReset();
    });

    // SES v2 MessageHeaderValue: "Can contain any printable ASCII character",
    // max 995; name + value ≤ 996; at most 15 headers.
    it('custom headers ride Content.Simple.Headers; non-ASCII values become encoded-words', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 's',
        text: 't',
        attachments: [{ filename: 'a.txt', content: 'a' }],
        headers: { 'X-Campaign': 'spring', 'X-Label': 'Grüße' },
      });
      const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
        Content: { Simple: { Headers: Array<{ Name: string; Value: string }> } };
      };
      const headers = body.Content.Simple.Headers;
      expect(headers[0]).toEqual({ Name: 'X-Campaign', Value: 'spring' });
      expect(headers[1]!.Name).toBe('X-Label');
      expect(headers[1]!.Value).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
      expect(headers[1]!.Value).toMatch(/^[ -~]+$/);
    });

    // header-fields.html: with Simple content these "are disallowed as custom
    // headers: BCC, CC, Content-Disposition, Content-Type, Date, From,
    // Message-ID, MIME-Version, Reply-To, Return-Path, Subject, To".
    it.each(['Reply-To', 'to', 'CC', 'Bcc', 'From', 'Subject', 'Content-Type', 'MIME-Version', 'Date', 'Message-ID', 'Return-Path', 'Content-Disposition'])(
      'a custom %s header → invalid_request before signing',
      async (name) => {
        const err = await connector
          .send({ from: 'sender@example.com', to: 'r@example.com', subject: 's', text: 't', headers: { [name]: 'x' } })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).providerCode).toBe('invalid_request');
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['more than 15 headers', Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`X-H${i}`, 'v']))],
      ['a header name with a colon', { 'X-Bad:Name': 'v' }],
      ['a header name with a space', { 'X Bad': 'v' }],
      ['a value with a control character', { 'X-Tab': 'a\tb' }],
      ['an empty value', { 'X-Empty': '' }],
      ['name + value over 996 characters', { 'X-Long': 'a'.repeat(995) }],
    ])('%s → invalid_request before signing', async (_label, headers) => {
      const err = await connector
        .send({ from: 'sender@example.com', to: 'r@example.com', subject: 's', text: 't', headers })
        .catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('CR/LF in a custom header value → invalid_request naming only the header', async () => {
      const err = (await connector
        .send({
          from: 'sender@example.com',
          to: 'r@example.com',
          subject: 's',
          text: 't',
          headers: { 'X-Inject': 'a\r\nBcc: evil@example.com' },
        })
        .catch((e: unknown) => e)) as ConnectorError;
      expect(err.providerCode).toBe('invalid_request');
      expect(err.message).toContain('X-Inject');
      expect(err.message).not.toContain('evil@example.com');
      expect(mockFetch).not.toHaveBeenCalled();
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

    it('propagates SES-narrowed input fields (sourceArn, returnPath alias, tags) to the wire body', async () => {
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
      // sesv2 SendEmailRequest has no ReturnPath; FeedbackForwardingEmailAddress
      // is "The address that you want bounce and complaint notifications to be sent to".
      expect(body).not.toHaveProperty('ReturnPath');
      expect(body.FeedbackForwardingEmailAddress).toBe('bounce@example.com');
      expect(body.EmailTags).toEqual([
        { Name: 'campaign', Value: 'spring' },
        { Name: 'env', Value: 'prod' },
      ]);
    });

    it('feedbackForwardingEmailAddress wins over the deprecated returnPath alias', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());
      await connector.send({
        from: 'sender@example.com',
        to: 'r@example.com',
        subject: 's',
        text: 't',
        feedbackForwardingEmailAddress: 'fb@example.com',
        returnPath: 'old@example.com',
      } as never);
      const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body.FeedbackForwardingEmailAddress).toBe('fb@example.com');
    });

    // SES v2 MessageTag Name/Value: "can only contain ASCII letters (a–z, A–Z),
    // numbers (0–9), underscores (_), or dashes (-)", max 256.
    it('a { Name } tag object with no Value → invalid_request before signing', async () => {
      const err = await connector
        .send({ from: 'sender@example.com', to: 'r@example.com', subject: 's', text: 't', tags: [{ Name: 'env' }] } as never)
        .catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([['welcome email'], ['a.b'], ['x'.repeat(257)]])('tag %j → invalid_request before signing', async (tag) => {
      const err = await connector
        .send({ from: 'sender@example.com', to: 'r@example.com', subject: 's', text: 't', tags: [tag] })
        .catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
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

    // API_SendEmail errors: MessageRejected (400) "The message content is invalid".
    it('maps 400 MessageRejected to invalid_request (it is about content, not a recipient)', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(400, {
          __type: 'MessageRejected',
          message: 'Email address is not verified.',
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
        expect(e.providerCode).toBe('invalid_request');
        expect(e.providerMessage).toBe('Email address is not verified.');
      }
    });

    // restJson1: botocore RestJSONParser._inject_error_code and aws-sdk-js-v3
    // loadRestJsonErrorCode read the x-amzn-ErrorType header first; its value
    // looks like "MessageRejected:http://internal.amazon.com/coral/...".
    it.each([
      ['SendingPausedException:http://internal.amazon.com/coral/com.amazonaws.sesv2/', 'auth_failed'],
      ['AccountSuspendedException:http://internal.amazon.com/', 'auth_failed'],
      ['MessageRejected:http://internal.amazon.com/', 'invalid_request'],
      ['MailFromDomainNotVerifiedException', 'invalid_request'],
      ['TooManyRequestsException', 'rate_limited'],
      ['LimitExceededException', 'invalid_request'],
    ])('reads the code from the x-amzn-ErrorType header: %s → %s', async (header, expected) => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'm' }), {
          status: 400,
          headers: { 'x-amzn-ErrorType': header },
        }),
      );
      const err = await connector
        .send({ from: 'sender@example.com', to: 'r@example.com', subject: 's', text: 't' })
        .catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe(expected);
      expect((err as ConnectorError).providerMessage).toBe('m');
    });

    it('reads a lowercase body `code` and a namespaced `__type`', async () => {
      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(400, { code: 'SendingPausedException', message: 'paused' }),
      );
      const e1 = (await connector
        .send({ from: 'sender@example.com', to: 'r@example.com', subject: 's', text: 't' })
        .catch((e: unknown) => e)) as ConnectorError;
      expect(e1.providerCode).toBe('auth_failed');

      mockFetch.mockResolvedValueOnce(
        sesErrorResponse(400, { __type: 'com.amazonaws.sesv2#AccountSuspendedException', message: 'x' }),
      );
      const e2 = (await connector
        .send({ from: 'sender@example.com', to: 'r@example.com', subject: 's', text: 't' })
        .catch((e: unknown) => e)) as ConnectorError;
      expect(e2.providerCode).toBe('auth_failed');
    });

    it.each(['x.evil.example/', 'us-east-1.evil.example', ''])(
      'region %j → invalid_request before signing (it is part of the credentialed host)',
      async (region) => {
        const c = new SesEmailConnector({ ...defaultConfig, region });
        const e1 = await c
          .send({ from: 'sender@example.com', to: 'r@example.com', subject: 's', text: 't' })
          .catch((e: unknown) => e);
        const e2 = await c
          .sendMessage({ to: ['r@example.com'], subject: 's', html: '<p>h</p>' })
          .catch((e: unknown) => e);
        for (const e of [e1, e2]) expect((e as ConnectorError).providerCode).toBe('invalid_request');
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

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
  // Novu-compatible `sendMessage()` surface
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

    it('sends attachments as Content.Simple.Attachments (cid → INLINE)', async () => {
      mockFetch.mockResolvedValueOnce(sesSuccessResponse());

      const fileBuffer = Buffer.from('file-content-here');
      await connector.sendMessage({
        to: ['recipient@example.com'],
        subject: 'Attachment Test',
        html: '<p>See attached</p>',
        attachments: [
          { mime: 'application/pdf', file: fileBuffer, name: 'report.pdf' },
          { mime: 'image/png', file: Buffer.from('png'), name: 'logo.png', cid: 'logo' },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.Content).not.toHaveProperty('Raw');
      expect(body.Content.Simple.Attachments).toEqual([
        {
          FileName: 'report.pdf',
          RawContent: fileBuffer.toString('base64'),
          ContentType: 'application/pdf',
          ContentDisposition: 'ATTACHMENT',
        },
        {
          FileName: 'logo.png',
          RawContent: Buffer.from('png').toString('base64'),
          ContentType: 'image/png',
          ContentDisposition: 'INLINE',
          ContentId: 'logo',
        },
      ]);
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
        // Same classification path as send(): mapSesErrorToProviderCode
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

describe('Email#checkIntegration() on SES', () => {
  it('reports that SES needs options instead of a TypeError, and sends nothing', async () => {
    const f = vi.fn();
    mockFetch.mockReset();
    const email = new Email('ses', {
      region: 'us-east-1',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      from: 'a@example.com',
      fetch: f as unknown as typeof fetch,
    });
    const r = await email.checkIntegration();
    expect(r.success).toBe(false);
    expect(r.message).toContain('IEmailOptions');
    expect(r.message).not.toContain('Cannot read properties');
    expect(f).not.toHaveBeenCalled();
  });
});
