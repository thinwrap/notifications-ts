import { BaseConnector } from '../../base/base.connector';
import { CasingEnum, transformKeys } from '../../base/casing-transform';
import type {
  IEmailOptions,
  IEmailProvider,
  ISendMessageSuccessResponse,
  WithPassthrough,
  EmailSendInput,
  EmailSendResult,
  IEmailConnector,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import { encodeBase64Ascii, encodeBase64Bytes } from '../../utils';
import type { PostmarkConfig } from './postmark.config';
import type {
  PostmarkSendEmailResponse,
  PostmarkErrorResponse,
} from './postmark.types';

const POSTMARK_ENDPOINT = 'https://api.postmarkapp.com/email';

export class PostmarkEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'postmark';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: PostmarkConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   * Hand-builds Postmark's PascalCase JSON wire body and POSTs to
   * `https://api.postmarkapp.com/email` with `X-Postmark-Server-Token` auth.
   *
   * Postmark is also the canonical example of two outlier mappings:
   *   1. **Single-tag normalization** — Postmark accepts only one `Tag` per
   *      email. Thinwrap's `tags: string[]` (9/9 providers conceptually) is
   *      capped first-tag-wins inside `buildPostmarkBody()`. No error, no
   *      warning — graceful degradation the >=90% baseline-coverage rule.
   *   2. **Headers Record→array adapter** — Postmark uniquely requires
   *      `Headers: Array<{Name,Value}>` rather than the flat
   *      `Record<string,string>` shape every other connector uses. The
   * conversion lives inside this connector (outlier wire
   *      translation locality).
   *
   * Postmark also returns 200 OK with `ErrorCode !== 0` on rejection (see
   * ) — those are mapped to a 422-equivalent application error
   * re-thrown through `mapVendorError()`.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const connectorBody = this.buildPostmarkBody(input);

    // explicit per-connector casing-transform invocation on consumer's
    // `_passthrough.body`. Postmark's wire shape is PascalCase, so consumer
    // camelCase keys (`templateModel`) become PascalCase (`TemplateModel`).
    const normalizedPassthroughBody =
      input._passthrough?.body !== undefined
        ? (transformKeys(
            input._passthrough.body as Record<string, unknown>,
            CasingEnum.PASCAL_CASE,
          ) as Record<string, unknown>)
        : undefined;
    const normalizedPassthrough =
      input._passthrough && normalizedPassthroughBody !== undefined
        ? { ...input._passthrough, body: normalizedPassthroughBody }
        : input._passthrough;

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': this.config.serverToken,
        },
        normalizedPassthrough,
      );

    const queryString = buildQueryString(mergedQuery);
    const url = `${POSTMARK_ENDPOINT}${queryString}`;
    const serializedBody = JSON.stringify(mergedBody);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: mergedHeaders,
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

    const raw = (await response.json().catch(() => null)) as
      | (PostmarkSendEmailResponse & Partial<PostmarkErrorResponse>)
      | null;

    if (!response.ok) {
      throw this.mapVendorError(response.status, raw, response.headers);
    }

    // Postmark 200 with embedded application-level error.
    if (raw && raw.ErrorCode !== 0) {
      throw this.mapVendorError(422, raw, response.headers);
    }

    return {
      success: true,
      status: 'sent',
      providerMessageId: raw?.MessageID ?? null,
      raw: raw ?? {},
    };
  }

  /**
   * Hand-build Postmark's PascalCase wire body from Thinwrap's `EmailSendInput`.
   * (locality), the structural wire translation is local to
   * this connector — no automatic casing transform on connector-built keys.
   *
   * Single-tag normalization rules:
   *   - `tags === undefined || tags.length === 0` → omit `Tag`.
   *   - `tags.length === 1` → `Tag: tags[0]`.
   *   - `tags.length > 1` → `Tag: tags[0]` (first-tag-wins; remainder silently
   *     dropped). No error, no warning the wrapper holds no state.
   */
  private buildPostmarkBody(input: EmailSendInput): Record<string, unknown> {
    const fromAddress = input.from || this.config.from;
    const fromEmailAddress = this.config.senderName
      ? `${this.config.senderName} <${fromAddress}>`
      : fromAddress;

    const body: Record<string, unknown> = {
      From: fromEmailAddress,
      To: (Array.isArray(input.to) ? input.to : [input.to]).join(', '),
      Subject: input.subject,
    };

    if (input.cc && input.cc.length > 0) {
      body.Cc = (Array.isArray(input.cc) ? input.cc : [input.cc]).join(', ');
    }
    if (input.bcc && input.bcc.length > 0) {
      body.Bcc = (Array.isArray(input.bcc) ? input.bcc : [input.bcc]).join(', ');
    }
    if (input.html) body.HtmlBody = input.html;
    if (input.text) body.TextBody = input.text;
    if (input.replyTo) body.ReplyTo = input.replyTo;

    // Headers: Record<string,string> → Array<{Name,Value}>.
    if (input.headers) {
      body.Headers = Object.entries(input.headers).map(([Name, Value]) => ({
        Name,
        Value,
      }));
    }

    // Single-tag normalization: first-tag-wins; remainder dropped.
    if (input.tags && input.tags.length > 0) {
      body.Tag = input.tags[0];
    }

    if (this.config.messageStream) {
      body.MessageStream = this.config.messageStream;
    }

    if (input.attachments && input.attachments.length > 0) {
      body.Attachments = input.attachments.map((a) => {
        const contentBase64 =
          typeof a.content === 'string'
            ? encodeBase64Ascii(a.content)
            : encodeBase64Bytes(a.content);
        const att: Record<string, unknown> = {
          Name: a.filename,
          Content: contentBase64,
        };
        if (a.contentType) att.ContentType = a.contentType;
        // Postmark requires the `cid:` prefix in ContentID for inline images.
        if (a.contentId) att.ContentID = `cid:${a.contentId}`;
        return att;
      });
    }

    return body;
  }

  /**
   * Map Postmark error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header value on
   * `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   *
   * Used for both real HTTP errors (4xx/5xx) and Postmark's embedded
   * application-level errors (200 + `ErrorCode !== 0`) — the latter are passed
   * with `status: 422`.
   */
  private mapVendorError(
    status: number,
    body: (PostmarkErrorResponse & Partial<PostmarkSendEmailResponse>) | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errorMessage = body?.Message ?? '<no vendor message>';
    const errorCode = body?.ErrorCode;

    const providerCode = mapPostmarkErrorToProviderCode(status, errorCode);

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
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IEmailOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const senderName = options.senderName ?? this.config.senderName;
    const from = options.from ?? this.config.from;
    const fromAddress = senderName ? `${senderName} <${from}>` : from;

    const payload: Record<string, unknown> = {
      From: fromAddress,
      To: options.to.join(', '),
      Subject: options.subject,
    };

    if (options.html) payload.HtmlBody = options.html;
    if (options.text) payload.TextBody = options.text;
    if (options.replyTo) payload.ReplyTo = options.replyTo;
    if (options.cc && options.cc.length > 0) payload.Cc = options.cc.join(', ');
    if (options.bcc && options.bcc.length > 0) payload.Bcc = options.bcc.join(', ');

    if (options.attachments && options.attachments.length > 0) {
      payload.Attachments = options.attachments.map((a) => ({
        Name: a.name ?? 'attachment',
        Content: encodeBase64Bytes(a.file),
        ContentType: a.mime,
      }));
    }

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': this.config.serverToken,
          ...passthroughHeaders,
        },
        body: JSON.stringify(body),
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

    const raw = (await response.json().catch(() => null)) as
      | (PostmarkSendEmailResponse & Partial<PostmarkErrorResponse>)
      | null;

    if (!response.ok) {
      throw this.mapVendorError(response.status, raw, response.headers);
    }

    if (raw && raw.ErrorCode !== 0) {
      throw this.mapVendorError(422, raw, response.headers);
    }

    return {
      id: raw?.MessageID,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function buildQueryString(query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return '';
  return '?' + new URLSearchParams(query).toString();
}

/**
 * Map Postmark (HTTP status, ErrorCode) to canonical `ProviderCode` per Story
 * 1.12. Postmark's `ErrorCode` is the disambiguator on 422 (and on 200
 * responses with embedded application-level errors, which are routed through
 * this function with `status: 422`).
 */
function mapPostmarkErrorToProviderCode(
  status: number,
  errorCode: number | undefined,
): ProviderCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';

  if (status === 422) {
    switch (errorCode) {
      case 300: // InactiveRecipient
      case 406: // InboundEmailNotAllowed
      case 411: // RecipientAddressNull
      case 412: // RecipientNotInRecipientList
        return 'invalid_recipient';
      case 405: // SenderSignatureNotConfirmed
        return 'auth_failed';
      case 1003: // InvalidEmailRequest — malformed
        return 'invalid_request';
      default:
        return 'invalid_request';
    }
  }

  return 'unknown';
}
