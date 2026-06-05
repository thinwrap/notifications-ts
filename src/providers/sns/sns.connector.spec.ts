import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { SnsSmsConnector } from './sns.connector';
import type { SnsConfig } from './sns.config';
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

const defaultConfig: SnsConfig = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const snsSuccessXml = `<PublishResponse xmlns="https://sns.amazonaws.com/doc/2010-03-31/">
  <PublishResult>
    <MessageId>abc-123-def-456</MessageId>
  </PublishResult>
  <ResponseMetadata>
    <RequestId>req-789</RequestId>
  </ResponseMetadata>
</PublishResponse>`;

const snsErrorXml = `<ErrorResponse xmlns="https://sns.amazonaws.com/doc/2010-03-31/">
  <Error>
    <Type>Sender</Type>
    <Code>InvalidParameter</Code>
    <Message>Invalid parameter: PhoneNumber</Message>
  </Error>
  <RequestId>req-err-001</RequestId>
</ErrorResponse>`;

function xmlResponse(xml: string, status = 200, headers?: Record<string, string>) {
  return new Response(xml, {
    status,
    headers: { 'Content-Type': 'text/xml', ...(headers ?? {}) },
  });
}

describe('SnsSmsConnector', () => {
  let connector: SnsSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new SnsSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path: POSTs Sig V4-signed form body and returns canonical SmsSendResult', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      const result = await connector.send({
        to: '+14155550100',
        body: 'Hello from SNS!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://sns.us-east-1.amazonaws.com/');
      expect(reqInit.method).toBe('POST');

      const headers = reqInit.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('Action')).toBe('Publish');
      expect(params.get('Version')).toBe('2010-03-31');
      expect(params.get('PhoneNumber')).toBe('+14155550100');
      expect(params.get('Message')).toBe('Hello from SNS!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'abc-123-def-456',
        raw: snsSuccessXml,
      });
    });

    it('uses the configured region in the endpoint URL (eu-west-1)', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));
      const euConnector = new SnsSmsConnector({ ...defaultConfig, region: 'eu-west-1' });

      await euConnector.send({ to: '+441234567890', body: 'Hello EU!' });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://sns.eu-west-1.amazonaws.com/');
    });

    it('sets PhoneNumber when input.to is provided', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({ to: '+14155550100', body: 'Hi' });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('PhoneNumber')).toBe('+14155550100');
      expect(params.get('TopicArn')).toBeNull();
    });

    it('sets TopicArn when input.topicArn is provided (without to)', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '',
        body: 'Topic broadcast',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('TopicArn')).toBe('arn:aws:sns:us-east-1:123456789012:my-topic');
      expect(params.get('PhoneNumber')).toBeNull();
    });

    it('forwards both PhoneNumber and TopicArn when both set (lets AWS reject)', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: 'Both',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('PhoneNumber')).toBe('+14155550100');
      expect(params.get('TopicArn')).toBe('arn:aws:sns:us-east-1:123456789012:my-topic');
    });

    it('throws invalid_request when neither to nor topicArn is provided', async () => {
      try {
        await connector.send({ to: '', body: 'Hi' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(400);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('flattens smsType into MessageAttributes.entry.1 indexed form', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
        smsType: 'Transactional',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('MessageAttributes.entry.1.Name')).toBe('AWS.SNS.SMS.SMSType');
      expect(params.get('MessageAttributes.entry.1.Value.DataType')).toBe('String');
      expect(params.get('MessageAttributes.entry.1.Value.StringValue')).toBe('Transactional');
    });

    it('flattens senderId and maxPrice convenience fields into MessageAttributes', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
        senderId: 'MyBrand',
        maxPrice: '0.50',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);

      // Collect indexed attribute entries
      const entries: Array<{ name: string; dataType: string; value: string }> = [];
      for (let i = 1; i <= 5; i++) {
        const name = params.get(`MessageAttributes.entry.${i}.Name`);
        if (name == null) break;
        entries.push({
          name,
          dataType: params.get(`MessageAttributes.entry.${i}.Value.DataType`) ?? '',
          value: params.get(`MessageAttributes.entry.${i}.Value.StringValue`) ?? '',
        });
      }

      expect(entries).toEqual(
        expect.arrayContaining([
          { name: 'AWS.SNS.SMS.SenderID', dataType: 'String', value: 'MyBrand' },
          { name: 'AWS.SNS.SMS.MaxPrice', dataType: 'Number', value: '0.50' },
        ]),
      );
    });

    it('forwards consumer-supplied messageAttributes alongside SMS convenience fields', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
        smsType: 'Promotional',
        messageAttributes: {
          'My.Custom.Attr': { DataType: 'String', StringValue: 'value-1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);

      const names: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const name = params.get(`MessageAttributes.entry.${i}.Name`);
        if (name == null) break;
        names.push(name);
      }

      expect(names).toEqual(
        expect.arrayContaining(['My.Custom.Attr', 'AWS.SNS.SMS.SMSType']),
      );
    });

    it('emits BinaryValue when MessageAttribute DataType is Binary', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
        messageAttributes: {
          'My.Binary.Attr': { DataType: 'Binary', BinaryValue: 'YmluYXJ5LWJ5dGVz' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('MessageAttributes.entry.1.Name')).toBe('My.Binary.Attr');
      expect(params.get('MessageAttributes.entry.1.Value.DataType')).toBe('Binary');
      expect(params.get('MessageAttributes.entry.1.Value.BinaryValue')).toBe('YmluYXJ5LWJ5dGVz');
    });

    it('forwards MessageStructure when provided', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: '{"default":"hi","sms":"hi via sms"}',
        messageStructure: 'json',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('MessageStructure')).toBe('json');
    });

    it('signs the request with AWS Signature V4 (hand-rolled signer)', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({ to: '+14155550100', body: 'Test' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;

      expect(headers.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/sns\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
      );
      expect(headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
      expect(headers['X-Amz-Content-Sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(headers.Host).toBe('sns.us-east-1.amazonaws.com');
    });

    it('propagates sessionToken into Sig V4 signing (STS credentials)', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));
      const conn = new SnsSmsConnector({
        ...defaultConfig,
        sessionToken: 'sts-session-token-value',
      });

      await conn.send({ to: '+14155550100', body: 'Hi' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      // The session token rides as X-Amz-Security-Token AND participates in
      // the signature (it is part of the canonical signed-header set).
      expect(headers['X-Amz-Security-Token']).toBe('sts-session-token-value');
      expect(headers.Authorization).toContain('x-amz-security-token');
    });

    it('produces the cross-verified deterministic signature for a fixed request', async () => {
      // Cross-verified byte-for-byte against `aws4@1.13.x` and
      // `aws4fetch@1.0.20` (when the `aws4` runtime dep was dropped) — same
      // fixed timestamp, credentials, body, and passthrough query → same
      // Authorization header from all three. Covers the case where
      // `_passthrough.query` is folded into the signed canonical query.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
      try {
        mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

        await connector.send({
          to: '+15555550100',
          body: 'Hello SNS',
          _passthrough: { query: { trace: 'on' } },
        });

        const [url, init] = mockFetch.mock.calls[0]!;
        expect(url).toBe('https://sns.us-east-1.amazonaws.com/?trace=on');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['X-Amz-Date']).toBe('20260516T000000Z');
        expect(headers.Authorization).toBe(
          'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260516/us-east-1/sns/aws4_request, ' +
            'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
            'Signature=7bce71c522db9181ad8816e3eda9160af8e26f454711d4db8fe11ca3765f69f7',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('matches the deterministic cross-language parity signature vector', async () => {
      // This is a fixed parity vector: identical credentials, timestamp, body,
      // and passthrough query must produce this exact Authorization header in
      // any language implementation (verified byte-for-byte).
      // Body deliberately space-free: TS serializes form bodies with `+` for
      // spaces (URLSearchParams), PHP with `%20` (rawurlencode), so a body
      // with spaces would diverge at the wire level, not the signer level.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-16T00:00:00.000Z'));
      try {
        mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

        await connector.send({
          to: '+15555550100',
          body: 'Hi',
          _passthrough: { query: { trace: 'on' } },
        });

        const [, init] = mockFetch.mock.calls[0]!;
        expect((init as RequestInit).body).toBe(
          'Action=Publish&Version=2010-03-31&Message=Hi&PhoneNumber=%2B15555550100',
        );
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe(
          'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260516/us-east-1/sns/aws4_request, ' +
            'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
            'Signature=ef9af20cba7c92a45fbabc0ab557ad08b1e91032547b79de9c37f0d8b93a6a15',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('honors _passthrough.body: extra fields are present in the signed form body', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
        _passthrough: { body: { CustomParam: 'x' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('CustomParam')).toBe('x');
      expect(params.get('Action')).toBe('Publish');
    });

    it('sends but does NOT sign hop-by-hop / runtime-owned passthrough headers', async () => {
      // Per the AWS signing guide ("Do not include hop-by-hop headers ...");
      // signing these invites SignatureDoesNotMatch when a proxy or the fetch
      // runtime rewrites them after signing.
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
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

    it('honors _passthrough.headers: custom header lands on the request', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
        _passthrough: { headers: { 'X-Custom-Header': 'custom-value' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['X-Custom-Header']).toBe('custom-value');
    });

    // -------------------------------------------------------------------------
    // Error mapping table
    // -------------------------------------------------------------------------

    it('maps 403 InvalidClientTokenId → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        xmlResponse(
          `<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>The security token is invalid</Message></Error></ErrorResponse>`,
          403,
        ),
      );

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(403);
        expect(e.providerCode).toBe('auth_failed');
        expect(e.providerMessage).toBe('The security token is invalid');
      }
    });

    it('maps 403 SignatureDoesNotMatch → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        xmlResponse(
          `<ErrorResponse><Error><Code>SignatureDoesNotMatch</Code><Message>Signature mismatch</Message></Error></ErrorResponse>`,
          403,
        ),
      );

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('auth_failed');
      }
    });

    it('maps 429 Throttling with Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: `<ErrorResponse><Error><Code>Throttling</Code><Message>Rate exceeded</Message></Error></ErrorResponse>`,
          contentType: 'text/xml',
        }),
      );

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('Rate exceeded');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('maps 400 InvalidParameter → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsErrorXml, 400));

      try {
        await connector.send({ to: 'invalid-number', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_request');
        expect(e.providerMessage).toBe('Invalid parameter: PhoneNumber');
      }
    });

    it('maps 5xx → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        xmlResponse(
          `<ErrorResponse><Error><Code>InternalFailure</Code><Message>Internal error</Message></Error></ErrorResponse>`,
          500,
        ),
      );

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });

    it('falls back to "SNS HTTP <status>" message when XML body is unparseable', async () => {
      mockFetch.mockResolvedValueOnce(new Response('garbage', { status: 503 }));

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(503);
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.providerMessage).toBe('SNS HTTP 503');
      }
    });

    it('wraps network errors as ConnectorError with provider_unavailable and statusCode null', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.statusCode).toBeNull();
      }
    });

    it('returns providerMessageId = null when 2xx response has no MessageId', async () => {
      mockFetch.mockResolvedValueOnce(
        xmlResponse('<PublishResponse><PublishResult></PublishResult></PublishResponse>'),
      );

      const result = await connector.send({ to: '+14155550100', body: 'x' });

      expect(result.providerMessageId).toBeNull();
      expect(result.success).toBe(true);
      expect(result.status).toBe('sent');
    });
  });

  // ===========================================================================
  // Brownfield Novu-shaped surface (preserved)
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('should have id "sns" and channelType SMS', () => {
      expect(connector.id).toBe('sns');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('should send a message successfully with correct URL and form-encoded body', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      const result = await connector.sendMessage({
        to: '+14155550100',
        content: 'Hello from SNS!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe('https://sns.us-east-1.amazonaws.com/');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      );

      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('Action')).toBe('Publish');
      expect(params.get('PhoneNumber')).toBe('+14155550100');
      expect(params.get('Message')).toBe('Hello from SNS!');

      expect(result).toEqual({ id: 'abc-123-def-456', date: expect.any(String) });
      expect(() => new Date(result.date!)).not.toThrow();
    });

    it('should use the configured region in the endpoint URL', async () => {
      const euConnector = new SnsSmsConnector({
        ...defaultConfig,
        region: 'eu-west-1',
      });

      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await euConnector.sendMessage({
        to: '+441234567890',
        content: 'Hello EU!',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://sns.eu-west-1.amazonaws.com/');
    });

    it('should sign the request with AWS Signature V4 (hand-rolled signer)', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.sendMessage({
        to: '+14155550100',
        content: 'Test',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;

      expect(headers).toHaveProperty('Authorization');
      expect(headers.Authorization).toContain('AWS4-HMAC-SHA256');
      expect(headers).toHaveProperty('X-Amz-Date');
    });

    it('should merge bridgeProviderData passthrough body into the request', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.sendMessage(
        { to: '+14155550100', content: 'Hello!' },
        {
          _passthrough: { body: { MessageAttributes: 'custom-value' } },
        },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('MessageAttributes')).toBe('custom-value');
      expect(params.get('Action')).toBe('Publish');
      expect(params.get('PhoneNumber')).toBe('+14155550100');
    });

    it('should merge bridgeProviderData passthrough headers into the request', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsSuccessXml));

      await connector.sendMessage(
        { to: '+14155550100', content: 'Hello!' },
        {
          _passthrough: { headers: { 'X-Custom-Header': 'custom-value' } },
        },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['X-Custom-Header']).toBe('custom-value');
    });

    it('should throw ConnectorError with provider details on API error', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse(snsErrorXml, 400));

      try {
        await connector.sendMessage({
          to: 'invalid-number',
          content: 'Test',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.message).toBe('Invalid parameter: PhoneNumber');
        expect(connectorErr.statusCode).toBe(400);
        // Brownfield now routes through canonical classifySnsError
        expect(connectorErr.providerCode).toBe('invalid_request');
        expect(connectorErr.providerMessage).toBe('Invalid parameter: PhoneNumber');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({
          to: '+14155550100',
          content: 'Test',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.message).toBe('Network failure');
        expect(connectorErr.statusCode).toBeNull();
        expect(connectorErr.providerCode).toBe('provider_unavailable');
      }
    });

    it('should return empty string as id when MessageId is not in XML response', async () => {
      mockFetch.mockResolvedValueOnce(
        xmlResponse('<PublishResponse><PublishResult></PublishResult></PublishResponse>'),
      );

      const result = await connector.sendMessage({
        to: '+14155550100',
        content: 'Test',
      });

      expect(result.id).toBe('');
      expect(result.date).toEqual(expect.any(String));
    });
  });
});
