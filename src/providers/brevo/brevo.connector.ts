import { BaseConnector } from '../../base/base.connector';
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
import { encodeBase64Utf8, encodeBase64Bytes } from '../../utils';
import type { BrevoConfig } from './brevo.config';
import type {
  BrevoSendResponse,
  BrevoErrorResponse,
} from './brevo.types';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export class BrevoEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'brevo';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: BrevoConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   *
   * ** pre-flight guard:** if any `attachments[].contentId` is set, throws
   * `ConnectorError({ providerCode: 'invalid_request', statusCode: 0 })` BEFORE
   * any HTTP call — Brevo's `/v3/smtp/email` has no first-class cid mechanism.
   * This is the canonical outlier "vendor doesn't support a baseline
   * field" throw the >=90% baseline-coverage rule.
   *
   * Brevo's wire shape is already camelCase, matching Thinwrap's input shape;
   * only field renames (`from` → `sender`, `html` → `htmlContent`,
   * `text` → `textContent`, `attachments` → `attachment` singular) are
   * hand-mapped inline. No `casingTransform()` invocation needed — neither on
   * the connector body nor on `_passthrough.body`.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    // === PRE-FLIGHT GUARD ===========================================
    // Brevo does not support per-attachment cid for inline images. Throw at
    // call-time rather than silently dropping the field (which would result
    // in broken inline images in recipients' inboxes). `statusCode: 0`
    // semantically marks this as pre-flight — no vendor response was received.
    if (
      input.attachments?.some(
        (a) => a.contentId !== undefined && a.contentId !== null,
      )
    ) {
      throw new ConnectorError({
        message:
          "Brevo does not support attachment contentId (inline cid:-referenced images). Use Brevo's templating system via _passthrough.body, or choose a provider that supports cid (e.g. SendGrid, SES, Mailgun).",
        statusCode: 0,
        providerCode: 'invalid_request',
        providerMessage:
          'Brevo does not support inline cid attachments via API; use Brevo template substitutions via _passthrough or pick another provider.',
      });
    }

    const connectorBody = this.buildBrevoBody(input);

    // No casing transform on _passthrough.body — Brevo wire is camelCase and
    // consumers are expected to write Brevo's camelCase shape directly.
    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'api-key': this.config.apiKey,
        },
        input._passthrough,
      );

    const url = BREVO_ENDPOINT;
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

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | BrevoErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as BrevoSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.messageId ?? null,
      raw,
    };
  }

  /**
   * Build the Brevo wire body from Thinwrap's `EmailSendInput`. Hand-maps the
   * field renames where Thinwrap's name diverges from Brevo's:
   *   - `from` → `sender: { email, name? }`
   *   - `to`/`cc`/`bcc` strings → `[{ email }]`
   *   - `html` → `htmlContent`, `text` → `textContent`
   *   - `replyTo` → `replyTo: { email }`
   *   - `attachments` → `attachment` (singular) — name + base64 content only.
   *
   * The `contentId` guard at the top of `send()` ensures that no attachment
   * here carries a `contentId`. Brevo's attachment shape supports only
   * `{ name, content }`; `contentType` is implicit from filename per their docs.
   */
  private buildBrevoBody(input: EmailSendInput): Record<string, unknown> {
    const fromAddress = input.from || this.config.from;
    const sender = this.config.senderName
      ? { name: this.config.senderName, email: fromAddress }
      : { email: fromAddress };

    const toList = (Array.isArray(input.to) ? input.to : [input.to]).map(
      (email) => ({ email }),
    );

    const body: Record<string, unknown> = {
      sender,
      to: toList,
      subject: input.subject,
    };

    if (input.cc && input.cc.length > 0) {
      body.cc = (Array.isArray(input.cc) ? input.cc : [input.cc]).map(
        (email) => ({ email }),
      );
    }
    if (input.bcc && input.bcc.length > 0) {
      body.bcc = (Array.isArray(input.bcc) ? input.bcc : [input.bcc]).map(
        (email) => ({ email }),
      );
    }
    if (input.html) body.htmlContent = input.html;
    if (input.text) body.textContent = input.text;
    if (input.replyTo) body.replyTo = { email: input.replyTo };
    if (input.headers) body.headers = input.headers;
    if (input.tags && input.tags.length > 0) body.tags = input.tags;

    if (input.attachments && input.attachments.length > 0) {
      body.attachment = input.attachments.map((a) => {
        const contentBase64 =
          typeof a.content === 'string'
            ? encodeBase64Utf8(a.content)
            : encodeBase64Bytes(a.content);
        // Brevo's attachment shape: { name, content }. ContentType is implicit
        // from filename per Brevo's docs; contentId is rejected at top of send().
        return { name: a.filename, content: contentBase64 };
      });
    }

    return body;
  }

  /**
   * Map Brevo error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header value on
   * `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    status: number,
    body: BrevoErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errorMessage = body?.message ?? '<no vendor message>';
    const errorCode = body?.code;

    const providerCode = mapBrevoErrorToProviderCode(
      status,
      errorCode,
      errorMessage,
    );

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
    // same pre-flight guard as send() — Brevo does not support
    // attachment cid; throw if any attachment has cid set.
    if (
      options.attachments?.some(
        (a) => a.cid !== undefined && a.cid !== null,
      )
    ) {
      throw new ConnectorError({
        message:
          "Brevo does not support attachment cid (inline cid:-referenced images).",
        statusCode: 0,
        providerCode: 'invalid_request',
      });
    }

    const senderName = options.senderName ?? this.config.senderName;
    const from = options.from ?? this.config.from;

    const payload: Record<string, unknown> = {
      sender: senderName
        ? { name: senderName, email: from }
        : { email: from },
      to: options.to.map((email) => ({ email })),
      subject: options.subject,
    };

    if (options.html) payload.htmlContent = options.html;
    if (options.text) payload.textContent = options.text;
    if (options.replyTo) {
      payload.replyTo = { email: options.replyTo };
    }
    if (options.cc && options.cc.length > 0) {
      payload.cc = options.cc.map((email) => ({ email }));
    }
    if (options.bcc && options.bcc.length > 0) {
      payload.bcc = options.bcc.map((email) => ({ email }));
    }

    if (options.attachments && options.attachments.length > 0) {
      payload.attachment = options.attachments.map((a) => ({
        name: a.name ?? 'attachment',
        content: encodeBase64Bytes(a.file),
      }));
    }

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.config.apiKey,
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

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | BrevoErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as BrevoSendResponse;
    return {
      id: data.messageId,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Map Brevo (HTTP status, error code, message) to canonical `ProviderCode` per
 * .
 *
 * | HTTP | Brevo code / condition           | ProviderCode          |
 * |------|----------------------------------|-----------------------|
 * | 400  | invalid_parameter (recipient)    | invalid_recipient     |
 * | 400  | invalid_parameter (other)        | invalid_request       |
 * | 400  | missing_parameter                | invalid_request       |
 * | 401  | unauthorized                     | auth_failed           |
 * | 402  | credit_exhausted                 | auth_failed           |
 * | 403  | permission_denied                | auth_failed           |
 * | 404  | document_not_found (template)    | invalid_request       |
 * | 429  | too_many_requests                | rate_limited          |
 * | 5xx  | unavailable                      | provider_unavailable  |
 * | else | unrecognized                     | unknown               |
 */
function mapBrevoErrorToProviderCode(
  status: number,
  _code: string | undefined,
  message: string,
): ProviderCode {
  if (status === 401 || status === 402 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';

  if (status === 400) {
    return /recipient|to\[|email address|sender/i.test(message)
      ? 'invalid_recipient'
      : 'invalid_request';
  }

  if (status === 404) return 'invalid_request';

  return 'unknown';
}
