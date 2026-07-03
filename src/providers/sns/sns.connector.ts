import crypto from 'crypto';
import { BaseConnector } from '../../base/base.connector';
import type {
  ISmsOptions,
  ISmsProvider,
  ISendMessageSuccessResponse,
  WithPassthrough,
  SmsSendResult,
  ISmsConnector,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import type { SnsConfig } from './sns.config';
import type { SnsMessageAttribute, SnsNarrowedInput } from './sns.types';

export class SnsSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'sns';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: SnsConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * Builds an `application/x-www-form-urlencoded` AWS Query API body, signs
   * with hand-rolled AWS Sig V4 against `node:crypto` (no third-party crypto
   * dependency — see `signSnsRequest`), and POSTs to
   * `https://sns.<region>.amazonaws.com/`.
   *
   * Outlier locality wins over DRY: the signer lives inside this
   * connector module even though the SES connector holds a near-identical
   * copy.
   *
   * `messageAttributes` is flattened into the indexed AWS Query form
   * (`MessageAttributes.entry.N.Name` / `.Value.DataType` / `.Value.StringValue`)
   * BEFORE signing, so the signed canonical request covers the flattened keys.
   * `_passthrough` body merge also happens before signing so consumer-supplied
   * extra fields authenticate alongside the connector-built ones.
   */
  async send(input: SnsNarrowedInput): Promise<SmsSendResult> {
    if (!input.to && !input.topicArn) {
      throw new ConnectorError({
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage: 'SNS requires either `to` (phone E.164) or `topicArn`.',
      });
    }

    const connectorBody: Record<string, string> = {
      Action: 'Publish',
      Version: '2010-03-31',
      Message: input.body,
    };
    if (input.to) connectorBody.PhoneNumber = input.to;
    if (input.topicArn) connectorBody.TopicArn = input.topicArn;
    if (input.messageStructure) connectorBody.MessageStructure = input.messageStructure;

    // Merge SMS-convenience fields into messageAttributes.
    const attrs: Record<string, SnsMessageAttribute> = {
      ...(input.messageAttributes ?? {}),
    };
    if (input.smsType) {
      attrs['AWS.SNS.SMS.SMSType'] = { DataType: 'String', StringValue: input.smsType };
    }
    if (input.senderId) {
      attrs['AWS.SNS.SMS.SenderID'] = { DataType: 'String', StringValue: input.senderId };
    }
    if (input.maxPrice) {
      attrs['AWS.SNS.SMS.MaxPrice'] = { DataType: 'Number', StringValue: input.maxPrice };
    }

    // Flatten to AWS Query indexed-key form.
    Object.entries(attrs).forEach(([name, value], idx) => {
      const i = idx + 1;
      connectorBody[`MessageAttributes.entry.${i}.Name`] = name;
      connectorBody[`MessageAttributes.entry.${i}.Value.DataType`] = value.DataType;
      if (value.StringValue !== undefined) {
        connectorBody[`MessageAttributes.entry.${i}.Value.StringValue`] = value.StringValue;
      }
      if (value.BinaryValue !== undefined) {
        connectorBody[`MessageAttributes.entry.${i}.Value.BinaryValue`] = value.BinaryValue;
      }
    });

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody as unknown as Record<string, unknown>,
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        input._passthrough,
      );

    const host = `sns.${this.config.region}.amazonaws.com`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(mergedBody)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const serializedBody = params.toString();

    // include any `_passthrough.query` in the signed path AND the request
    // URL — folded (sorted) into the SigV4 canonical query string identically
    // to the URL encoding, else SignatureDoesNotMatch.
    const canonicalQuery = buildCanonicalQuery(mergedQuery);
    const path = '/' + (canonicalQuery ? '?' + canonicalQuery : '');

    const signedHeaders = signSnsRequest({
      region: this.config.region,
      host,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      serializedBody,
      additionalSignedHeaders: mergedHeaders,
      isoTimestamp: isoBasicTimestamp(),
      canonicalQuery,
    });

    let response: Response;
    try {
      // Signed values win on collision — Host/X-Amz-Date/Authorization are
      // not consumer-overridable. Caller-merged passthrough headers participate
      // in the signature; subsequent AWS-managed headers replace any collisions.
      response = await this.fetchImpl(`https://${host}${path}`, {
        method: 'POST',
        headers: { ...mergedHeaders, ...signedHeaders },
        body: serializedBody,
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new ConnectorError({
          message: (error as Error).message ?? 'Request cancelled',
          statusCode: null,
          providerCode: 'invalid_request',
          cause: error,
        });
      }
      throw new ConnectorError({
        message: (error as Error).message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errXml = await response.text().catch(() => null);
      throw this.mapVendorError(response.status, errXml, response.headers);
    }

    const xml = await response.text();
    const messageId = extractXmlTag(xml, 'MessageId');

    return {
      success: true,
      status: 'sent',
      providerMessageId: messageId ?? null,
      raw: xml,
    };
  }

  /**
   * Map SNS XML error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`: parsed seconds embedded in
   * `providerMessage` text; raw header value on `cause.retryAfter`. No
   * top-level structured `retryAfterSeconds` field — retry is consumer policy.
   */
  private mapVendorError(
    status: number,
    xml: string | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const code = extractXmlTag(xml, 'Code');
    const message = extractXmlTag(xml, 'Message');
    const providerCode = classifySnsError(status, code);
    const baseMessage = message ?? `SNS HTTP ${status}`;

    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const cause: Record<string, unknown> = { raw: xml };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    return new ConnectorError({
      message: baseMessage,
      statusCode: status,
      providerCode,
      providerMessage: baseMessage,
      cause,
    });
  }

  // ---------------------------------------------------------------------------
  // Novu-shaped compatibility surface
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: ISmsOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const payload = {
      Action: 'Publish',
      PhoneNumber: options.to,
      Message: options.content,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      params.append(key, String(value));
    }

    const host = `sns.${this.config.region}.amazonaws.com`;
    const serializedBody = params.toString();

    const signedHeaders = signSnsRequest({
      region: this.config.region,
      host,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      serializedBody,
      additionalSignedHeaders: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      isoTimestamp: isoBasicTimestamp(),
      canonicalQuery: '',
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`https://${host}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...passthroughHeaders,
          ...signedHeaders,
        },
        body: serializedBody,
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new ConnectorError({
          message: (error as Error).message ?? 'Request cancelled',
          statusCode: null,
          providerCode: 'invalid_request',
          cause: error,
        });
      }
      throw new ConnectorError({
        message: (error as Error).message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errXml = await response.text().catch(() => null);
      throw this.mapVendorError(response.status, errXml, response.headers);
    }

    const xml = await response.text();
    const messageId = extractXmlTag(xml, 'MessageId') ?? '';

    return {
      id: messageId,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Headers never folded into the Sig V4 signature, even when supplied via
 * `_passthrough.headers` (they are still sent on the wire, just unsigned —
 * AWS only validates headers listed in `SignedHeaders`). Per the AWS signing
 * guide: "Do not include hop-by-hop headers that are frequently altered
 * during transit" — proxies, load balancers, and the `fetch()` runtime
 * itself rewrite these after signing, which would invalidate the signature.
 * `content-length` is additionally runtime-owned under `fetch()` (undici
 * recomputes it from the body). Mirrors `@smithy/signature-v4`
 * ALWAYS_UNSIGNABLE_HEADERS plus `content-length`. Note `Content-Type` is
 * deliberately NOT here: the same guide requires it signed when present.
 */
const UNSIGNABLE_HEADERS = new Set([
  'authorization',
  'cache-control',
  'connection',
  'content-length',
  'expect',
  'from',
  'keep-alive',
  'max-forwards',
  'pragma',
  'proxy-authenticate',
  'proxy-authorization',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'x-amzn-trace-id',
]);

/**
 * Hand-rolled AWS Sig V4. The `aws4` runtime dependency was dropped: it
 * targets Node-style request options rather than `fetch()`, and the signing
 * algorithm is only ~50 lines against `node:crypto`, which keeps the package
 * free of third-party runtime dependencies.
 * Returns the headers that must attach to the request: Host, X-Amz-Date,
 * X-Amz-Content-Sha256, Authorization, and (optionally) X-Amz-Security-Token.
 *
 * Outlier locality wins over DRY: this signer lives inside the connector
 * module even though the SES connector holds a near-identical copy.
 *
 * `additionalSignedHeaders` are headers beyond the AWS-managed set that must
 * participate in the signature (e.g., Content-Type plus passthrough headers).
 * `canonicalQuery` is the sorted, RFC 3986-encoded query string (no leading
 * `?`); empty when no passthrough query.
 */
function signSnsRequest(opts: {
  region: string;
  host: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  serializedBody: string;
  additionalSignedHeaders: Record<string, string>;
  isoTimestamp: string;
  canonicalQuery: string;
}): Record<string, string> {
  const service = 'sns';
  const dateStamp = opts.isoTimestamp.slice(0, 8);

  const hashedPayload = crypto
    .createHash('sha256')
    .update(opts.serializedBody)
    .digest('hex');

  // Canonical headers — Host, X-Amz-Date, X-Amz-Content-Sha256, plus any
  // caller-supplied headers (e.g., Content-Type from connector + any
  // passthrough headers).
  const canonicalHeaders: Record<string, string> = {
    ...opts.additionalSignedHeaders,
    Host: opts.host,
    'X-Amz-Date': opts.isoTimestamp,
    'X-Amz-Content-Sha256': hashedPayload,
  };
  if (opts.sessionToken) {
    canonicalHeaders['X-Amz-Security-Token'] = opts.sessionToken;
  }

  // Lower-case names (last-wins on case-only collisions, like the PHP
  // sibling's assoc-array overwrite), trim + collapse internal whitespace
  // runs in values per the Sig V4 canonicalization spec; sort by name.
  // Hop-by-hop / runtime-owned headers are excluded from the signature.
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(canonicalHeaders)) {
    const lowerName = name.toLowerCase();
    if (UNSIGNABLE_HEADERS.has(lowerName)) continue;
    normalized[lowerName] = String(value).trim().replace(/\s+/g, ' ');
  }
  const sortedNames = Object.keys(normalized).sort();

  const canonicalHeadersString = sortedNames
    .map((name) => `${name}:${normalized[name]}\n`)
    .join('');
  const signedHeadersList = sortedNames.join(';');

  const canonicalRequest = `POST\n/\n${opts.canonicalQuery}\n${canonicalHeadersString}\n${signedHeadersList}\n${hashedPayload}`;

  const credentialScope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${opts.isoTimestamp}\n${credentialScope}\n` +
    crypto.createHash('sha256').update(canonicalRequest).digest('hex');

  const hmac = (key: crypto.BinaryLike, data: string): Buffer =>
    crypto.createHmac('sha256', key).update(data).digest();
  const kDate = hmac('AWS4' + opts.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  const out: Record<string, string> = {
    Host: opts.host,
    'X-Amz-Date': opts.isoTimestamp,
    'X-Amz-Content-Sha256': hashedPayload,
    Authorization: authorization,
  };
  if (opts.sessionToken) {
    out['X-Amz-Security-Token'] = opts.sessionToken;
  }

  return out;
}

/**
 * Sig V4 basic-format timestamp (`YYYYMMDD'T'HHMMSS'Z'`).
 */
function isoBasicTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Build the SigV4 canonical query string: keys sorted, each key/value RFC
 * 3986-encoded, joined `k=v&...`. Identical encoding is appended to the
 * request URL so URL and signature agree.
 */
function buildCanonicalQuery(query: Record<string, string>): string {
  const keys = Object.keys(query).sort();
  if (keys.length === 0) return '';
  return keys
    .map((key) => `${rfc3986Encode(key)}=${rfc3986Encode(query[key]!)}`)
    .join('&');
}

/**
 * RFC 3986 percent-encoding (PHP `rawurlencode` equivalent):
 * `encodeURIComponent` plus the `!'()*` set it leaves bare.
 */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function extractXmlTag(
  xml: string | null | undefined,
  tag: string,
): string | undefined {
  if (!xml) return undefined;
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return match?.[1];
}

/**
 * Map SNS (HTTP status, XML `<Code>`) to canonical `ProviderCode` via the
 * error-mapping table. HTTP-layer first, then body-layer
 * `<Code>` value disambiguates within 4xx.
 */
function classifySnsError(
  status: number,
  code: string | undefined,
): ProviderCode {
  if (
    code === 'InvalidClientTokenId' ||
    code === 'SignatureDoesNotMatch' ||
    status === 401 ||
    status === 403
  ) {
    return 'auth_failed';
  }
  if (
    code === 'Throttling' ||
    code === 'ThrottlingException' ||
    status === 429
  ) {
    return 'rate_limited';
  }
  if (status >= 500) return 'provider_unavailable';
  if (code === 'InvalidParameter' || code === 'InvalidParameterValue') {
    return 'invalid_request';
  }
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}
