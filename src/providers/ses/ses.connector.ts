import crypto from 'crypto';
import { BaseConnector } from '../../base/base.connector';
import type {
  IEmailOptions,
  IAttachmentOptions,
  IEmailProvider,
  ISendMessageSuccessResponse,
  ICheckIntegrationResponse,
  WithPassthrough,
  EmailSendInput,
  EmailSendResult,
  EmailAttachment,
  IEmailConnector,
} from '../../types';
import { ChannelTypeEnum, CheckIntegrationResponseEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import { encodeBase64Ascii, encodeBase64Bytes } from '../../utils';
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
    const senderName = this.config.senderName;
    const fromAddress = input.from || this.config.from;
    const fromEmailAddress = senderName
      ? `${senderName} <${fromAddress}>`
      : fromAddress;

    const destination: SesV2SendEmailRequest['Destination'] = {
      ToAddresses: [input.to],
    };

    if (input.cc && input.cc.length > 0) {
      destination.CcAddresses = input.cc;
    }

    if (input.bcc && input.bcc.length > 0) {
      destination.BccAddresses = input.bcc;
    }

    let content: SesV2SendEmailRequest['Content'];

    if (input.attachments && input.attachments.length > 0) {
      const mimeMessage = this.buildMimeMessageFromInput(
        fromEmailAddress,
        input.to,
        input.cc,
        input.bcc,
        input.replyTo,
        input.subject,
        input.html ?? '',
        input.text,
        input.attachments,
      );
      content = {
        Raw: {
          Data: encodeBase64Ascii(mimeMessage),
        },
      };
    } else {
      const body: {
        Html?: { Data: string; Charset: string };
        Text?: { Data: string; Charset: string };
      } = {};

      if (input.html) {
        body.Html = { Data: input.html, Charset: 'UTF-8' };
      }

      if (input.text) {
        body.Text = { Data: input.text, Charset: 'UTF-8' };
      }

      content = {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: body,
        },
      };
    }

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

    if (input.returnPath) {
      requestBody.ReturnPath = input.returnPath;
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
    const errorType =
      body?.__type ?? body?.type ?? body?.Code ?? '';
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

  /**
   * Build a raw multipart MIME message for SES `Content.Raw.Data` from
   * Thinwrap's `EmailAttachment` shape. Headers are CRLF-stripped to
   * prevent header injection. Non-ASCII Subject/From/To
   * ReplyTo headers are RFC 2047 base64-encoded.
   */
  private buildMimeMessageFromInput(
    from: string,
    to: string,
    cc: string[] | undefined,
    bcc: string[] | undefined,
    replyTo: string | undefined,
    subject: string,
    html: string,
    text: string | undefined,
    attachments: EmailAttachment[],
  ): string {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const lines: string[] = [];

    lines.push(`From: ${encodeHeaderValue(from)}`);
    lines.push(`To: ${stripCrlf(to)}`);

    if (cc && cc.length > 0) {
      lines.push(`Cc: ${cc.map(stripCrlf).join(', ')}`);
    }

    if (bcc && bcc.length > 0) {
      lines.push(`Bcc: ${bcc.map(stripCrlf).join(', ')}`);
    }

    if (replyTo) {
      lines.push(`Reply-To: ${stripCrlf(replyTo)}`);
    }

    lines.push(`Subject: ${encodeHeaderValue(subject)}`);
    lines.push('MIME-Version: 1.0');
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');

    lines.push(`--${boundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push('');

    if (text) {
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/plain; charset=UTF-8');
      lines.push('Content-Transfer-Encoding: 7bit');
      lines.push('');
      lines.push(text);
      lines.push('');
    }

    if (html) {
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/html; charset=UTF-8');
      lines.push('Content-Transfer-Encoding: 7bit');
      lines.push('');
      lines.push(html);
      lines.push('');
    }

    lines.push(`--${altBoundary}--`);
    lines.push('');

    for (const attachment of attachments) {
      const contentType = attachment.contentType ?? 'application/octet-stream';
      const filename = quoteMimeFilename(attachment.filename);

      let encoded: string;
      if (typeof attachment.content === 'string') {
        encoded = encodeBase64Ascii(attachment.content);
      } else {
        encoded = encodeBase64Bytes(attachment.content);
      }

      lines.push(`--${boundary}`);
      lines.push(`Content-Type: ${contentType}; name=${filename}`);
      lines.push('Content-Transfer-Encoding: base64');

      if (attachment.contentId) {
        lines.push(`Content-ID: <${stripCrlf(attachment.contentId)}>`);
        lines.push(`Content-Disposition: inline; filename=${filename}`);
      } else {
        lines.push(`Content-Disposition: attachment; filename=${filename}`);
      }

      lines.push('');
      lines.push(encoded);
      lines.push('');
    }

    lines.push(`--${boundary}--`);
    lines.push('');

    return lines.join('\r\n');
  }

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IEmailOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const senderName = options.senderName ?? this.config.senderName;
    const from = options.from ?? this.config.from;
    const fromEmailAddress = senderName ? `${senderName} <${from}>` : from;

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

    let content: SesV2SendEmailRequest['Content'];

    if (options.attachments && options.attachments.length > 0) {
      const mimeMessage = this.buildMimeMessage(
        fromEmailAddress,
        options.to,
        options.cc,
        options.bcc,
        options.replyTo,
        options.subject,
        options.html,
        options.text,
        options.attachments
      );
      content = {
        Raw: {
          Data: encodeBase64Ascii(mimeMessage),
        },
      };
    } else {
      const body: { Html?: { Data: string; Charset: string }; Text?: { Data: string; Charset: string } } = {};

      if (options.html) {
        body.Html = { Data: options.html, Charset: 'UTF-8' };
      }

      if (options.text) {
        body.Text = { Data: options.text, Charset: 'UTF-8' };
      }

      content = {
        Simple: {
          Subject: { Data: options.subject, Charset: 'UTF-8' },
          Body: body,
        },
      };
    }

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
          headers: {
            'Content-Type': 'application/json',
            ...signedHeaders,
            ...mergedHeaders,
          },
          body: serializedBody,
        }
      );
    } catch (error) {
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

  async checkIntegration(
    options: IEmailOptions
  ): Promise<ICheckIntegrationResponse> {
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

  private buildMimeMessage(
    from: string,
    to: string[],
    cc: string[] | undefined,
    bcc: string[] | undefined,
    replyTo: string | undefined,
    subject: string,
    html: string,
    text: string | undefined,
    attachments: IAttachmentOptions[]
  ): string {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const lines: string[] = [];

    lines.push(`From: ${encodeHeaderValue(from)}`);
    lines.push(`To: ${to.map(stripCrlf).join(', ')}`);

    if (cc && cc.length > 0) {
      lines.push(`Cc: ${cc.map(stripCrlf).join(', ')}`);
    }

    if (bcc && bcc.length > 0) {
      lines.push(`Bcc: ${bcc.map(stripCrlf).join(', ')}`);
    }

    if (replyTo) {
      lines.push(`Reply-To: ${stripCrlf(replyTo)}`);
    }

    lines.push(`Subject: ${encodeHeaderValue(subject)}`);
    lines.push('MIME-Version: 1.0');
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');

    lines.push(`--${boundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push('');

    if (text) {
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/plain; charset=UTF-8');
      lines.push('Content-Transfer-Encoding: 7bit');
      lines.push('');
      lines.push(text);
      lines.push('');
    }

    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(html);
    lines.push('');

    lines.push(`--${altBoundary}--`);
    lines.push('');

    for (const attachment of attachments) {
      const filename = quoteMimeFilename(attachment.name ?? 'attachment');
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: ${attachment.mime}; name=${filename}`);
      lines.push('Content-Transfer-Encoding: base64');

      if (attachment.cid) {
        lines.push(`Content-ID: <${stripCrlf(attachment.cid)}>`);
        lines.push(`Content-Disposition: ${attachment.disposition ?? 'inline'}; filename=${filename}`);
      } else {
        lines.push(`Content-Disposition: ${attachment.disposition ?? 'attachment'}; filename=${filename}`);
      }

      lines.push('');
      lines.push(encodeBase64Bytes(attachment.file));
      lines.push('');
    }

    lines.push(`--${boundary}--`);
    lines.push('');

    return lines.join('\r\n');
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
 * Strip CR/LF characters from email header values to prevent header injection.
 * MIME header field bodies cannot contain bare CR/LF; any caller-supplied
 * value that does is sanitised to spaces.
 */
function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Encode a non-ASCII header value using RFC 2047 base64 encoded-word form
 * (`=?UTF-8?B?<base64>?=`). ASCII values pass through unchanged. Always
 * CRLF-stripped (defence in depth).
 */
function encodeHeaderValue(value: string): string {
  const stripped = stripCrlf(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(stripped)) {
    return stripped;
  }
  const utf8Bytes = new TextEncoder().encode(stripped);
  return `=?UTF-8?B?${encodeBase64Bytes(utf8Bytes)}?=`;
}

/**
 * Quote a MIME filename that may contain `"` or other special characters per
 * RFC 2183. Bare filenames are quoted; embedded `"` is backslash-escaped.
 */
function quoteMimeFilename(name: string): string {
  const stripped = stripCrlf(name);
  return `"${stripped.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * SES expects `EmailTags: [{Name, Value}]`. The base `EmailSendInput.tags` is
 * `string[]`; the narrowed `SesEmailSendInput.tags` is the SES-shaped array.
 * Accept both: bare strings become `{Name: tag, Value: tag}`; already-shaped
 * objects pass through unchanged.
 */
function liftSesTags(
  tags: string[] | SesEmailTag[] | undefined,
): SesEmailTag[] {
  if (!tags || tags.length === 0) return [];
  return tags.map((tag) => {
    if (typeof tag === 'string') {
      return { Name: tag, Value: tag };
    }
    return tag;
  });
}

/**
 * Map SES v2 (HTTP status, error-type-code) to canonical `ProviderCode`.
 * Truth table.
 */
function mapSesErrorToProviderCode(
  status: number,
  errorType: string,
): ProviderCode {
  // Normalize: SES sometimes uses `com.amazonaws.services.email#FooException`
  // shape on `__type`; we match the suffix only.
  const code = errorType.split('#').pop() ?? errorType;

  if (status === 429 || status === 454) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';

  if (status === 403) return 'auth_failed';
  if (status === 401) return 'auth_failed';

  if (status === 404) return 'invalid_request';

  if (status === 400) {
    if (
      code === 'MessageRejected' ||
      code === 'InvalidEmailAddress'
    ) {
      return 'invalid_recipient';
    }
    if (
      code === 'AccountSendingPaused' ||
      code === 'AccountSendingPausedException' ||
      code === 'AccountSuspended' ||
      code === 'AccountSuspendedException'
    ) {
      return 'auth_failed';
    }
    if (
      code === 'MailFromDomainNotVerified' ||
      code === 'MailFromDomainNotVerifiedException' ||
      code === 'FromEmailAddressNotVerified' ||
      code === 'FromEmailAddressNotVerifiedException' ||
      code === 'ValidationException' ||
      code === 'InvalidParameter' ||
      code === 'InvalidParameterValue' ||
      code === 'BadRequestException'
    ) {
      return 'invalid_request';
    }
    if (code === 'Throttling' || code === 'ThrottlingException') {
      return 'rate_limited';
    }
    return 'invalid_request';
  }

  if (code === 'Throttling' || code === 'ThrottlingException') {
    return 'rate_limited';
  }

  return 'unknown';
}
