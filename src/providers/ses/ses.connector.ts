import crypto from 'crypto';
import { BaseConnector } from '../../base/base.connector';
import type {
  IEmailOptions,
  IEmailProvider,
  ISendMessageSuccessResponse,
  ICheckIntegrationResponse,
  WithPassthrough,
  EmailSendInput,
  EmailSendResult,
  IEmailConnector,
} from '../../types';
import { ChannelTypeEnum, CheckIntegrationResponseEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { assertAwsRegion, mergePassthrough, mergeHeaders } from '../../utils';
import { parseRetryAfter } from '../../utils';
import { encodeBase64Utf8, encodeBase64Bytes } from '../../utils';
import { encodeWords, formatMailbox } from '../../utils';
import type { SesConfig } from './ses.config';
import type {
  SesV2SendEmailRequest,
  SesV2SendEmailResponse,
  SesV2ErrorResponse,
  SesEmailSendInput,
} from './ses.types';

type SesEmailTag = { Name: string; Value: string };

export class SesEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'ses';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: SesConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   * Builds a SES v2 SendEmail JSON body, signs with hand-rolled AWS Sig V4
   * against `node:crypto` (no third-party crypto dependency; the
   * `aws4` dep was dropped — see `signSesRequest`), and POSTs to
   * `https://email.<region>.amazonaws.com/v2/email/outbound-emails`.
   *
   * The region comes exclusively from `config.region` — no environment
   * inference, no shared-credentials-file fallback.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    assertAwsRegion(this.config.region, 'SES');
    const sesInput = input as SesEmailSendInput;
    const requestBody = this.buildSesV2Body(sesInput);

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        requestBody as unknown as Record<string, unknown>,
        { 'Content-Type': 'application/json' },
        input._passthrough,
      );

    const host = `email.${this.config.region}.amazonaws.com`;
    // a `_passthrough.query` must be folded (sorted) into BOTH the
    // request URL AND the SigV4 canonical query string; otherwise it is
    // either silently dropped or produces a SignatureDoesNotMatch.
    const canonicalQuery = buildCanonicalQuery(mergedQuery);
    const path =
      '/v2/email/outbound-emails' + (canonicalQuery ? '?' + canonicalQuery : '');
    const serializedBody = JSON.stringify(mergedBody);

    const signedHeaders = signSesRequest({
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
        headers: mergeHeaders(mergedHeaders, signedHeaders),
        body: serializedBody,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
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
        cause: error,
      });
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | SesV2ErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as SesV2SendEmailResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.MessageId ?? null,
      raw,
    };
  }

  /**
   * Build the SES v2 SendEmail JSON body from Thinwrap's `EmailSendInput`.
   * Hand-coded PascalCase mapping (locality) — no automatic casing
   * transform; SES's wire shape is structural and irregular (e.g.,
   * `Subject: { Data, Charset }` not just `Subject`).
   */
  private buildSesV2Body(input: SesEmailSendInput): SesV2SendEmailRequest {
    const fromAddress = input.from || this.config.from;
    const fromEmailAddress = formatMailbox(this.config.senderName, fromAddress);

    const destination: SesV2SendEmailRequest['Destination'] = {
      ToAddresses: [input.to],
    };

    if (input.cc && input.cc.length > 0) {
      destination.CcAddresses = input.cc;
    }

    if (input.bcc && input.bcc.length > 0) {
      destination.BccAddresses = input.bcc;
    }

    const simple = buildSimpleContent(input.subject, input.html, input.text);
    const headers = buildSimpleHeaders(input.headers);
    if (headers.length > 0) simple.Headers = headers;
    if (input.attachments && input.attachments.length > 0) {
      simple.Attachments = input.attachments.map((a) => ({
        FileName: a.filename,
        RawContent:
          typeof a.content === 'string' ? encodeBase64Utf8(a.content) : encodeBase64Bytes(a.content),
        ContentDisposition: a.contentId ? 'INLINE' : 'ATTACHMENT',
        ...(a.contentType ? { ContentType: a.contentType } : {}),
        ...(a.contentId ? { ContentId: a.contentId } : {}),
      }));
    }
    const content: SesV2SendEmailRequest['Content'] = { Simple: simple };

    const requestBody: SesV2SendEmailRequest = {
      FromEmailAddress: fromEmailAddress,
      Destination: destination,
      Content: content,
    };

    if (input.replyTo) {
      requestBody.ReplyToAddresses = [input.replyTo];
    }

    // Per-send override of configurationSetName takes precedence over config.
    const configurationSetName =
      input.configurationSetName ?? this.config.configurationSetName;
    if (configurationSetName) {
      requestBody.ConfigurationSetName = configurationSetName;
    }

    if (input.sourceArn) {
      requestBody.FromEmailAddressIdentityArn = input.sourceArn;
    }

    // SES v2 has no `ReturnPath` (that is the v1 SendEmail field); its
    // equivalent is `FeedbackForwardingEmailAddress`, "The address that you
    // want bounce and complaint notifications to be sent to".
    const feedbackAddress = input.feedbackForwardingEmailAddress ?? input.returnPath;
    if (feedbackAddress) {
      requestBody.FeedbackForwardingEmailAddress = feedbackAddress;
    }

    const sesTags = liftSesTags(input.tags);
    if (sesTags.length > 0) {
      requestBody.EmailTags = sesTags;
    }

    return requestBody;
  }

  /**
   * Map SES v2 error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. `cause` is shaped
   * as `{ raw: vendorBody, retryAfter?: <raw header> }`;
   * the parsed seconds are exposed as `cause.retryAfterSeconds` when available
   * but NOT inlined into `providerMessage`.
   */
  private mapVendorError(
    status: number,
    body: SesV2ErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    // restJson1 error code precedence, as botocore (`RestJSONParser
    // ._inject_error_code`) and aws-sdk-js-v3 (`loadRestJsonErrorCode`) read
    // it: the `x-amzn-ErrorType` header, then body `code`/`Code`, then
    // `__type`. SES v2 sends the header on every error.
    const errorType =
      responseHeaders.get('x-amzn-errortype') ??
      body?.code ??
      body?.Code ??
      body?.__type ??
      body?.type ??
      '';
    const errorMessage =
      body?.message ?? body?.Message ?? '<no vendor message>';

    const providerCode = mapSesErrorToProviderCode(status, errorType);

    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) {
      cause.retryAfter = retryAfterHeader;
    }
    if (retryAfterSeconds != null) {
      cause.retryAfterSeconds = retryAfterSeconds;
    }

    return new ConnectorError({
      message: errorMessage,
      statusCode: status,
      providerCode,
      providerMessage: errorMessage,
      cause,
    });
  }

  // ---------------------------------------------------------------------------
  // Novu-compatible `sendMessage()` surface
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IEmailOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    assertAwsRegion(this.config.region, 'SES');
    const senderName = options.senderName ?? this.config.senderName;
    const from = options.from ?? this.config.from;
    const fromEmailAddress = formatMailbox(senderName, from);

    const destination: SesV2SendEmailRequest['Destination'] = {
      ToAddresses: options.to,
    };

    if (options.cc && options.cc.length > 0) {
      destination.CcAddresses = options.cc;
    }

    if (options.bcc && options.bcc.length > 0) {
      destination.BccAddresses = options.bcc;
    }

    const replyToAddresses = options.replyTo ? [options.replyTo] : undefined;

    const simple = buildSimpleContent(options.subject, options.html, options.text);
    if (options.attachments && options.attachments.length > 0) {
      simple.Attachments = options.attachments.map((a) => ({
        FileName: a.name ?? 'attachment',
        RawContent: encodeBase64Bytes(a.file),
        ContentType: a.mime,
        ContentDisposition: novuDisposition(a.disposition, a.cid),
        ...(a.cid ? { ContentId: a.cid } : {}),
      }));
    }
    // Same SES header rules as `.send()` (reserved names, ASCII, limits).
    const novuHeaders = buildSimpleHeaders(options.headers);
    if (novuHeaders.length > 0) simple.Headers = novuHeaders;
    const content: SesV2SendEmailRequest['Content'] = { Simple: simple };

    const requestBody: Record<string, unknown> = {
      FromEmailAddress: fromEmailAddress,
      Destination: destination,
      Content: content,
    };

    if (replyToAddresses) {
      requestBody.ReplyToAddresses = replyToAddresses;
    }

    if (this.config.configurationSetName) {
      requestBody.ConfigurationSetName = this.config.configurationSetName;
    }

    const { body, headers: mergedHeaders } = mergePassthrough(
      requestBody,
      {},
      bridgeProviderData._passthrough,
    );

    const host = `email.${this.config.region}.amazonaws.com`;
    const serializedBody = JSON.stringify(body);

    const signedHeaders = signSesRequest({
      region: this.config.region,
      host,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      serializedBody,
      additionalSignedHeaders: { 'Content-Type': 'application/json' },
      isoTimestamp: isoBasicTimestamp(),
      canonicalQuery: '',
    });

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://${host}/v2/email/outbound-emails`,
        {
          method: 'POST',
          headers: mergeHeaders(
            { 'Content-Type': 'application/json', ...mergedHeaders },
            signedHeaders,
          ),
          body: serializedBody,
        }
      );
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError({
        message: (error as Error).message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | SesV2ErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as SesV2SendEmailResponse;
    return {
      id: data.MessageId,
      date: new Date().toISOString(),
    };
  }

  /**
   * Novu-compatible check: it SENDS `options` as a real email (SES has no
   * side-effect-free credential probe on this API). Without options there is
   * nothing to send, so it reports that instead of failing on `undefined`.
   */
  async checkIntegration(
    options?: IEmailOptions
  ): Promise<ICheckIntegrationResponse> {
    if (!options) {
      return {
        success: false,
        message:
          'SES checkIntegration needs IEmailOptions: it verifies the integration by sending that email.',
        code: CheckIntegrationResponseEnum.FAILED,
      };
    }
    try {
      await this.sendMessage(options);

      return {
        success: true,
        message: 'Integration successful',
        code: CheckIntegrationResponseEnum.SUCCESS,
      };
    } catch (error) {
      if (error instanceof ConnectorError) {
        const code =
          error.statusCode === 403 || error.statusCode === 401
            ? CheckIntegrationResponseEnum.BAD_CREDENTIALS
            : CheckIntegrationResponseEnum.FAILED;

        return {
          success: false,
          message: error.providerMessage ?? error.message,
          code,
        };
      }

      return {
        success: false,
        message: (error as Error).message ?? 'Unknown error',
        code: CheckIntegrationResponseEnum.FAILED,
      };
    }
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
 * Outlier locality wins over DRY: this signer lives inside the
 * connector module even though the SNS connector holds a near-identical copy.
 *
 * `additionalSignedHeaders` are headers beyond the AWS-managed set that must
 * participate in the signature (e.g., Content-Type plus passthrough headers).
 * `canonicalQuery` is the sorted, RFC 3986-encoded query string (no leading
 * `?`); empty when no passthrough query.
 */
function signSesRequest(opts: {
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
  const service = 'ses';
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

  const canonicalRequest = `POST\n/v2/email/outbound-emails\n${opts.canonicalQuery}\n${canonicalHeadersString}\n${signedHeadersList}\n${hashedPayload}`;

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

/**
 * SES expects `EmailTags: [{Name, Value}]`. The base `EmailSendInput.tags` is
 * `string[]`; the narrowed `SesEmailSendInput.tags` is the SES-shaped array.
 * Accept both: bare strings become `{Name: tag, Value: tag}`; already-shaped
 * objects pass through unchanged.
 *
 * SES v2 `MessageTag`: Name and Value "can only contain ASCII letters (a–z,
 * A–Z), numbers (0–9), underscores (_), or dashes (-)" and "no more than 256
 * characters", so a tag like `welcome email` is rejected here rather than
 * by a 400 from SES.
 */
function liftSesTags(
  tags: string[] | SesEmailTag[] | undefined,
): SesEmailTag[] {
  if (!tags || tags.length === 0) return [];
  return tags.map((tag) => {
    const lifted = typeof tag === 'string' ? { Name: tag, Value: tag } : tag;
    // `RegExp.test(undefined)` tests the string "undefined", so the types are
    // checked first: a `{ Name }` with no `Value` must not slip through.
    if (
      typeof lifted.Name !== 'string' ||
      typeof lifted.Value !== 'string' ||
      !SES_TAG_NAME.test(lifted.Name) ||
      !SES_TAG_VALUE.test(lifted.Value)
    ) {
      throw invalidSesRequest(
        `SES tag ${JSON.stringify(lifted.Name)}: Name and Value may contain only ASCII letters, digits, "_" and "-" (max 256).`,
      );
    }
    return lifted;
  });
}

const SES_TAG_NAME = /^[A-Za-z0-9_-]{1,256}$/;
const SES_TAG_VALUE = /^[A-Za-z0-9_-]{0,256}$/;

type SesSimpleContent = Extract<SesV2SendEmailRequest['Content'], { Simple: unknown }>['Simple'];

function buildSimpleContent(subject: string, html: string | undefined, text: string | undefined): SesSimpleContent {
  const body: SesSimpleContent['Body'] = {};
  if (html) body.Html = { Data: html, Charset: 'UTF-8' };
  if (text) body.Text = { Data: text, Charset: 'UTF-8' };
  return { Subject: { Data: subject, Charset: 'UTF-8' }, Body: body };
}

/**
 * Headers SES sets itself. header-fields.html: with Simple or Templated
 * content "you cannot set custom header content for headers that are set by
 * SES; therefore, the following headers are disallowed as custom headers".
 * Each maps to a typed field instead (named in the error).
 */
const SES_DISALLOWED_HEADERS: Readonly<Record<string, string | null>> = {
  bcc: 'bcc',
  cc: 'cc',
  'content-disposition': 'attachments',
  'content-type': 'html / text / attachments',
  date: null,
  from: 'from / senderName',
  'message-id': null,
  'mime-version': null,
  'reply-to': 'replyTo',
  'return-path': 'feedbackForwardingEmailAddress',
  subject: 'subject',
  to: 'to',
};

// SES v2 MessageHeaderName pattern `^[!-9;-@A-~]+$` (printable ASCII except
// ":"), max 126.
const SES_HEADER_NAME = /^[!-9;-@A-~]{1,126}$/;
// MessageHeaderValue pattern `[ -~]*`, 1–995 characters.
const SES_HEADER_VALUE = /^[ -~]{1,995}$/;

/**
 * Map `input.headers` onto SES v2 `Content.Simple.Headers`, enforcing the
 * model's rules before sending: at most 15 headers, names printable ASCII
 * without ":", values printable ASCII (non-ASCII values are RFC 2047
 * encoded-words, which are ASCII), name + value ≤ 996 characters, and none of
 * the headers SES reserves.
 */
function buildSimpleHeaders(
  headers: Record<string, string> | undefined,
): Array<{ Name: string; Value: string }> {
  if (!headers) return [];
  const entries = Object.entries(headers);
  if (entries.length > 15) {
    throw invalidSesRequest('SES accepts at most 15 custom headers per message.');
  }
  return entries.map(([name, rawValue]) => {
    const lower = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SES_DISALLOWED_HEADERS, lower)) {
      const field = SES_DISALLOWED_HEADERS[lower];
      throw invalidSesRequest(
        field
          ? `SES does not accept a custom "${name}" header; use ${field} instead.`
          : `SES does not accept a custom "${name}" header; SES sets it itself.`,
      );
    }
    if (!SES_HEADER_NAME.test(name)) {
      throw invalidSesRequest(
        `SES header name ${JSON.stringify(name)} must be 1–126 printable ASCII characters without ":".`,
      );
    }
    const text = String(rawValue);
    // A CR/LF/NUL in a header value is refused, not rewritten: silently
    // turning `a\r\nb` into `a b` would send something the caller did not
    // write. The message names the header, never its value.
    if (/[\r\n\0]/.test(text)) {
      throw invalidSesRequest(`SES header "${name}" value must not contain CR, LF or NUL.`);
    }
    const value = encodeWords(text.trim());
    if (!SES_HEADER_VALUE.test(value) || name.length + value.length > 996) {
      throw invalidSesRequest(
        `SES header "${name}" value must be 1–995 printable ASCII characters (name + value ≤ 996).`,
      );
    }
    return { Name: name, Value: value };
  });
}

/** Novu `IAttachmentOptions.disposition` is free text; SES takes an enum. */
function novuDisposition(disposition: string | undefined, cid: string | undefined): 'INLINE' | 'ATTACHMENT' {
  if (disposition !== undefined) return disposition.toLowerCase() === 'inline' ? 'INLINE' : 'ATTACHMENT';
  return cid ? 'INLINE' : 'ATTACHMENT';
}

function invalidSesRequest(message: string): ConnectorError {
  return new ConnectorError({
    message,
    statusCode: null,
    providerCode: 'invalid_request',
    providerMessage: message,
  });
}

/**
 * Reduce an AWS error code to its bare name the way the SDKs do. The header
 * form is `MessageRejected:http://internal.amazon.com/...`, and `__type` may
 * be `com.amazonaws.services.email#FooException`: aws-sdk-js-v3 cuts at ","
 * then ":", botocore splits on ":" and then keeps the part after the last
 * "#".
 */
function sanitizeAwsErrorCode(raw: string): string {
  const cut = raw.split(',')[0]!.split(':')[0]!;
  return cut.split('#').pop()!.trim();
}

/**
 * Map SES v2 (HTTP status, error code) to canonical `ProviderCode`, per the
 * SendEmail errors in https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html.
 * Six of them share HTTP 400, so the code decides. v1 (`AccountSendingPaused*`,
 * `InvalidEmailAddress`, …) names stay as harmless aliases.
 */
function mapSesErrorToProviderCode(
  status: number,
  errorType: string,
): ProviderCode {
  const code = sanitizeAwsErrorCode(errorType);

  if (status === 429 || status === 454) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';

  if (status === 403) return 'auth_failed';
  if (status === 401) return 'auth_failed';

  if (status === 404) return 'invalid_request';

  if (status === 400) {
    // v2 `MessageRejected`: "The message content is invalid" — the content,
    // not a recipient.
    if (code === 'MessageRejected') return 'invalid_request';
    if (code === 'InvalidEmailAddress') return 'invalid_recipient';
    if (
      code === 'SendingPausedException' ||
      code === 'AccountSendingPaused' ||
      code === 'AccountSendingPausedException' ||
      code === 'AccountSuspended' ||
      code === 'AccountSuspendedException'
    ) {
      return 'auth_failed';
    }
    if (
      code === 'Throttling' ||
      code === 'ThrottlingException' ||
      code === 'TooManyRequestsException'
    ) {
      return 'rate_limited';
    }
    // MailFromDomainNotVerifiedException, LimitExceededException,
    // BadRequestException, NotFoundException, ValidationException, …
    return 'invalid_request';
  }

  if (
    code === 'Throttling' ||
    code === 'ThrottlingException' ||
    code === 'TooManyRequestsException'
  ) {
    return 'rate_limited';
  }

  return 'unknown';
}
