import crypto from 'crypto';
import { BaseConnector } from '../../base/base.connector';
import type {
  IEmailOptions,
  IAttachmentOptions,
  IEmailProvider,
  ISendMessageSuccessResponse,
  WithPassthrough,
  EmailSendInput,
  EmailSendResult,
  EmailAttachment,
  IEmailConnector,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import { encodeBase64Ascii } from '../../utils';
import { formatMailbox, stripCrlf, escapeMimeFilename } from '../../utils';
import type { MailgunConfig } from './mailgun.config';
import type {
  MailgunSendResponse,
  MailgunErrorResponse,
} from './mailgun.types';

export class MailgunEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'mailgun';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: MailgunConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   * Builds either an `application/x-www-form-urlencoded` body (no attachments)
   * or a `multipart/form-data` body (with attachments), authenticates with
   * HTTP Basic (`api:<apiKey>`), and POSTs to
   * `https://api.mailgun.net/v3/<domain>/messages` (or the EU equivalent when
   * `region: 'eu'`). Returns `status: 'queued'` — Mailgun's response
   * is queue acceptance, not delivery confirmation.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const url = this.messagesUrl();
    const username = this.config.username ?? 'api';
    const auth = encodeBase64Ascii(`${username}:${this.config.apiKey}`);

    const fields = this.buildMailgunFields(input);

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
      fields,
      { Authorization: `Basic ${auth}` },
      input._passthrough,
    );
    const entries = formEntries(collapseHeaderFields(mergedBody));

    let requestBody: string | Buffer;
    let contentType: string;

    if (input.attachments && input.attachments.length > 0) {
      const { body: multipartBody, boundary } = this.buildMultipartBody(
        entries,
        input.attachments,
        input.tags,
      );
      requestBody = multipartBody;
      // The boundary contains `=` (a tspecial per RFC 2045), so the Content-Type
      // parameter MUST be quoted — an unquoted `=` can confuse a strict multipart
      // parser. (php/go use a `=`-free hex boundary and don't need quoting.)
      contentType = `multipart/form-data; boundary="${boundary}"`;
    } else {
      const params = new URLSearchParams();
      for (const [key, value] of entries) {
        params.append(key, value);
      }
      // Mailgun accepts repeated `o:tag` fields (up to 3); URLSearchParams handles
      // repeated keys natively. Truncate beyond 3 silently (graceful degradation
      // per the >=90% baseline-coverage rule).
      for (const tag of (input.tags ?? []).slice(0, 3)) {
        params.append('o:tag', tag);
      }
      requestBody = params.toString();
      contentType = 'application/x-www-form-urlencoded';
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { ...mergedHeaders, 'Content-Type': contentType },
        body: requestBody,
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
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | MailgunErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as MailgunSendResponse;
    return {
      success: true,
      status: 'queued',
      providerMessageId: raw.id ?? null,
      raw,
    };
  }

  /**
   * Build the Mailgun form-field record from Thinwrap's `EmailSendInput`.
   * Mailgun's wire keys are hand-mapped (locality): `replyTo` →
   * `h:Reply-To`, custom `headers` → `h:<Name>`. `o:tag` is appended later as
   * a repeated key (URLSearchParams handles repetition; a plain `Record` does
   * not, so tags are handled at serialization time).
   */
  private buildMailgunFields(input: EmailSendInput): Record<string, string> {
    const fromAddress = input.from || this.config.from;
    const fromEmailAddress = formatMailbox(this.config.senderName, fromAddress);

    const fields: Record<string, string> = {
      from: fromEmailAddress,
      to: Array.isArray(input.to) ? input.to.join(',') : input.to,
      subject: input.subject,
    };

    if (input.html) fields.html = input.html;
    if (input.text) fields.text = input.text;
    if (input.cc) {
      fields.cc = (Array.isArray(input.cc) ? input.cc : [input.cc]).join(',');
    }
    if (input.bcc) {
      fields.bcc = (Array.isArray(input.bcc) ? input.bcc : [input.bcc]).join(
        ',',
      );
    }
    // Header names are case-insensitive, but `h:Reply-To` and `h:reply-to`
    // are distinct form fields that Mailgun would turn into two headers. One
    // field per name survives: among `headers` the last case-variant wins, and
    // the typed `replyTo` wins over any `Reply-To` in `headers`.
    const headerKeyByLower = new Map<string, string>();
    const setHeader = (name: string, value: string): void => {
      // CRLF-strip the consumer-supplied header name before it becomes a
      // form-field key — the key is later interpolated into a multipart
      // Content-Disposition part header, where an embedded CR/LF would inject
      // arbitrary part headers.
      const key = `h:${stripCrlf(name)}`;
      const previous = headerKeyByLower.get(key.toLowerCase());
      if (previous !== undefined) delete fields[previous];
      fields[key] = value;
      headerKeyByLower.set(key.toLowerCase(), key);
    };
    if (input.headers) {
      for (const [name, value] of Object.entries(input.headers)) setHeader(name, value);
    }
    if (input.replyTo) setHeader('Reply-To', input.replyTo);

    return fields;
  }

  /**
   * Resolve `/v3/<domain>/messages`. The Basic credentials go to this URL, so
   * a `baseUrl` override must be https — Mailgun's own hosts
   * (`api.mailgun.net`, `api.eu.mailgun.net`) are https-only.
   */
  private messagesUrl(): string {
    const baseUrl =
      this.config.baseUrl ??
      (this.config.region === 'eu'
        ? 'https://api.eu.mailgun.net'
        : 'https://api.mailgun.net');
    if (!/^https:\/\//i.test(baseUrl)) {
      const message = 'Mailgun baseUrl must be an https:// URL.';
      throw new ConnectorError({
        message,
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: message,
      });
    }
    return `${baseUrl}/v3/${encodeURIComponent(this.config.domain)}/messages`;
  }

  /**
   * Map Mailgun error responses to canonical `ConnectorError` with the
   * 6-value `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text;
   * raw header value on `cause.retryAfter`. No structured `retryAfterSeconds`
   * field — retry is consumer policy.
   */
  private mapVendorError(
    status: number,
    body: MailgunErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errorMessage = body?.message ?? '<no vendor message>';
    const providerCode = mapMailgunErrorToProviderCode(status, errorMessage);

    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

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
    const url = this.messagesUrl();
    const senderName = options.senderName ?? this.config.senderName;
    const from = options.from ?? this.config.from;
    const fromAddress = formatMailbox(senderName, from);

    const payload: Record<string, unknown> = {
      from: fromAddress,
      to: options.to.join(','),
      subject: options.subject,
    };

    if (options.html) payload.html = options.html;
    if (options.text) payload.text = options.text;
    if (options.cc && options.cc.length > 0) payload.cc = options.cc.join(',');
    if (options.bcc && options.bcc.length > 0) payload.bcc = options.bcc.join(',');
    // Same `h:` mapping as `.send()`, applied BEFORE the passthrough merge so a
    // passthrough `h:*` key can still override it.
    if (options.headers) {
      for (const [name, value] of Object.entries(options.headers)) payload[`h:${stripCrlf(name)}`] = value;
    }
    if (options.replyTo) payload['h:Reply-To'] = options.replyTo;

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const formFields = formEntries(collapseHeaderFields(body));

    const username = this.config.username ?? 'api';
    const auth = encodeBase64Ascii(`${username}:${this.config.apiKey}`);

    let requestBody: string | Buffer;
    let contentType: string;

    if (options.attachments && options.attachments.length > 0) {
      const { body: multipartBody, boundary } = this.buildMultipartBodyLegacy(
        formFields,
        options.attachments
      );
      requestBody = multipartBody;
      // The boundary contains `=` (a tspecial per RFC 2045), so the Content-Type
      // parameter MUST be quoted — an unquoted `=` can confuse a strict multipart
      // parser. (php/go use a `=`-free hex boundary and don't need quoting.)
      contentType = `multipart/form-data; boundary="${boundary}"`;
    } else {
      const params = new URLSearchParams();
      for (const [key, value] of formFields) {
        params.append(key, value);
      }
      requestBody = params.toString();
      contentType = 'application/x-www-form-urlencoded';
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          Authorization: `Basic ${auth}`,
          ...passthroughHeaders,
        },
        body: requestBody,
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
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | MailgunErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as MailgunSendResponse;
    return {
      id: data.id,
      date: new Date().toISOString(),
    };
  }

  /**
   * Build a `multipart/form-data` body from Thinwrap's `EmailAttachment[]`
   * . Each attachment becomes a `name="attachment"` part (or
   * `name="inline"` when `contentId` is set, per Mailgun's cid pattern).
   */
  private buildMultipartBody(
    fields: Array<[string, string]>,
    attachments: EmailAttachment[],
    tags?: string[],
  ): { body: Buffer; boundary: string } {
    const boundary = `----=_Part_${randomBoundarySuffix()}`;
    const parts: Buffer[] = [];

    for (const [key, value] of fields) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMimeFilename(key)}"\r\n\r\n${value}\r\n`,
        ),
      );
    }

    // Mailgun `o:tag` must be emitted whether attachments are present or not.
    // Truncate beyond 3 silently.
    for (const tag of (tags ?? []).slice(0, 3)) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="o:tag"\r\n\r\n${tag}\r\n`,
        ),
      );
    }

    for (const attachment of attachments) {
      // Mailgun derives an inline part's Content-ID from its filename
      // (`-F inline=@email.jpg` is referenced as `cid:email.jpg`), so an inline
      // part is named by the caller's contentId.
      const filename = escapeMimeFilename(attachment.contentId || attachment.filename);
      const contentType = stripCrlf(
        attachment.contentType ?? 'application/octet-stream',
      );
      const fieldName = attachment.contentId ? 'inline' : 'attachment';

      let contentBuffer: Buffer;
      if (Buffer.isBuffer(attachment.content)) {
        contentBuffer = attachment.content;
      } else if (typeof attachment.content === 'string') {
        contentBuffer = Buffer.from(attachment.content, 'utf-8');
      } else {
        // Uint8Array / ArrayBuffer fallback
        contentBuffer = Buffer.from(attachment.content as Uint8Array);
      }

      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
        ),
      );
      parts.push(contentBuffer);
      parts.push(Buffer.from('\r\n'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    return { body: Buffer.concat(parts), boundary };
  }

  /**
   * Multipart builder for the Novu-compatible `sendMessage()` surface.
   * Consumes Novu's `IAttachmentOptions` shape (`name`/`mime`/`file`) — kept
   * separate from `buildMultipartBody()` so the new Thinwrap surface speaks
   * the post attachment shape exclusively.
   */
  private buildMultipartBodyLegacy(
    fields: Array<[string, string]>,
    attachments: IAttachmentOptions[]
  ): { body: Buffer; boundary: string } {
    const boundary = `----=_Part_${randomBoundarySuffix()}`;
    const parts: Buffer[] = [];

    for (const [key, value] of fields) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMimeFilename(key)}"\r\n\r\n${value}\r\n`
        )
      );
    }

    for (const attachment of attachments) {
      // A `cid` item is an inline image: Mailgun's `inline` field, named by the
      // cid because Mailgun uses the filename as the Content-ID.
      const name = escapeMimeFilename(attachment.cid || (attachment.name ?? 'attachment'));
      const fieldName = attachment.cid ? 'inline' : 'attachment';
      const contentType = stripCrlf(attachment.mime);
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${name}"\r\nContent-Type: ${contentType}\r\n\r\n`
        )
      );
      parts.push(Buffer.from(attachment.file));
      parts.push(Buffer.from('\r\n'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    return { body: Buffer.concat(parts), boundary };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Keep one `h:<Name>` field per header name, compared case-insensitively.
 * Mailgun turns each `h:` field into a header, so `h:Reply-To` plus a
 * passthrough `h:reply-to` would send two Reply-To headers. The later key in
 * merge order wins, which makes a passthrough `h:*` override the typed value
 * (passthrough is the documented escape hatch).
 */
function collapseHeaderFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keyByLower = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    if (/^h:/i.test(key)) {
      const lower = key.toLowerCase();
      const previous = keyByLower.get(lower);
      if (previous !== undefined) delete out[previous];
      keyByLower.set(lower, key);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Flatten a form record into ordered `[name, value]` entries. Mailgun repeats
 * a field for multiple values (`o:tag`, `to`) and takes `t:variables` /
 * `v:` data as "A valid JSON-encoded dictionary", so an array becomes repeated
 * fields and a plain object becomes compact JSON — never `String(value)`,
 * which yields `a,b` or `[object Object]`.
 */
function formEntries(record: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      out.push([key, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    }
  }
  return out;
}

/**
 * Cryptographically-random suffix for multipart/form-data boundaries. Uses
 * `node:crypto` instead of `Math.random()` so a boundary can't be
 * guessed/forced to collide with attacker-controlled body content.
 */
function randomBoundarySuffix(): string {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Map Mailgun (HTTP status, message) to canonical `ProviderCode` per
 * . Mailgun returns flat error bodies with the failure reason
 * as `message`. Recipient-malformed cases are disambiguated by message regex.
 */
function mapMailgunErrorToProviderCode(
  status: number,
  message: string,
): ProviderCode {
  // 403: "Forbidden — Valid credentials but access denied" (API overview).
  if (status === 401 || status === 402 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';

  if (status === 400) {
    return /not a valid email|invalid recipient|invalid address/i.test(message)
      ? 'invalid_recipient'
      : 'invalid_request';
  }

  if (status === 404 || status === 413) return 'invalid_request';

  return 'unknown';
}
