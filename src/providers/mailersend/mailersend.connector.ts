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
import type { MailerSendConfig } from './mailersend.config';
import type { MailerSendErrorResponse } from './mailersend.types';

const MAILERSEND_ENDPOINT = 'https://api.mailersend.com/v1/email';
const MAILERSEND_TAG_LIMIT = 5;

export class MailerSendEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'mailersend';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: MailerSendConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   * Builds the MailerSend `/v1/email` JSON body in snake_case wire shape and
   * POSTs to `https://api.mailersend.com/v1/email` with `Authorization: Bearer
   * <apiToken>`. the connector explicitly invokes
   * `transformKeys(_passthrough.body, CasingEnum.SNAKE_CASE)` before
   * `mergePassthrough` so consumer-supplied camelCase keys (e.g., `templateId`,
   * `sendAt`, `inReplyTo`, `personalization`) land as snake_case in the wire
   * body. MailerSend returns 202 Accepted with empty body; the message ID is
   * carried in the `X-Message-Id` response header.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const connectorBody = this.buildMailerSendBody(input);

    // explicit per-connector casing-transform invocation on consumer's
    // `_passthrough.body`. Only keys are rewritten; values are passed verbatim
    // by the underlying utility.
    const normalizedPassthroughBody =
      input._passthrough?.body !== undefined
        ? (transformKeys(
            input._passthrough.body as Record<string, unknown>,
            CasingEnum.SNAKE_CASE,
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
          Authorization: `Bearer ${this.config.apiToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        normalizedPassthrough,
      );

    const queryString = buildQueryString(mergedQuery);
    const url = `${MAILERSEND_ENDPOINT}${queryString}`;
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
        | MailerSendErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    // MailerSend 202 Accepted carries an empty body; the message ID is in the
    // `X-Message-Id` response header.
    const messageId = response.headers.get('x-message-id');
    return {
      success: true,
      status: 'queued',
      providerMessageId: messageId,
      raw: { messageId },
    };
  }

  /**
   * Build the MailerSend `/v1/email` wire body from Thinwrap's `EmailSendInput`.
   * Hand-mapped in snake_case (locality): `from`/`to`/`cc`/`bcc`
   * become `{ email, name? }` objects; `replyTo` is wrapped in a one-element
   * array as `reply_to`; `headers` (Record) is reshaped to MailerSend's
   * Array<{name, value}> shape; `tags` is truncated to MailerSend's 5-tag limit
   * with first-5-wins silent truncation (the >=90% baseline-coverage rule).
   */
  private buildMailerSendBody(input: EmailSendInput): Record<string, unknown> {
    const fromAddress = input.from || this.config.from;
    const fromObject = this.config.senderName
      ? { email: fromAddress, name: this.config.senderName }
      : { email: fromAddress };

    const toAddresses = (Array.isArray(input.to) ? input.to : [input.to]).map(
      (e) => ({ email: e }),
    );

    const body: Record<string, unknown> = {
      from: fromObject,
      to: toAddresses,
      subject: input.subject,
    };

    if (input.cc && input.cc.length > 0) {
      body.cc = input.cc.map((e) => ({ email: e }));
    }
    if (input.bcc && input.bcc.length > 0) {
      body.bcc = input.bcc.map((e) => ({ email: e }));
    }
    if (input.replyTo) {
      body.reply_to = [{ email: input.replyTo }];
    }
    if (input.html) body.html = input.html;
    if (input.text) body.text = input.text;

    if (input.headers) {
      body.headers = Object.entries(input.headers).map(([name, value]) => ({
        name,
        value,
      }));
    }

    if (input.tags && input.tags.length > 0) {
      // MailerSend allows up to 5 tags; truncate beyond 5 silently (graceful
      // degradation the >=90% baseline-coverage rule).
      body.tags = input.tags.slice(0, MAILERSEND_TAG_LIMIT);
    }

    if (input.attachments && input.attachments.length > 0) {
      body.attachments = input.attachments.map((a) => {
        const contentBase64 =
          typeof a.content === 'string'
            ? encodeBase64Ascii(a.content)
            : encodeBase64Bytes(a.content);
        const att: Record<string, unknown> = {
          filename: a.filename,
          content: contentBase64,
        };
        if (a.contentType) att.content_type = a.contentType;
        if (a.contentId) {
          att.id = a.contentId;
          att.disposition = 'inline';
        }
        return att;
      });
    }

    return body;
  }

  /**
   * Map MailerSend error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header value on
   * `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    status: number,
    body: MailerSendErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errorMessage = body?.message ?? '<no vendor message>';

    const providerCode = mapMailerSendErrorToProviderCode(status, body);

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

    const payload: Record<string, unknown> = {
      from: senderName ? { email: from, name: senderName } : { email: from },
      to: options.to.map((email) => ({ email })),
      subject: options.subject,
    };

    if (options.html) payload.html = options.html;
    if (options.text) payload.text = options.text;
    if (options.cc && options.cc.length > 0) {
      payload.cc = options.cc.map((email) => ({ email }));
    }
    if (options.bcc && options.bcc.length > 0) {
      payload.bcc = options.bcc.map((email) => ({ email }));
    }
    if (options.replyTo) {
      payload.reply_to = [{ email: options.replyTo }];
    }

    if (options.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments.map((a) => ({
        filename: a.name ?? 'attachment',
        content: encodeBase64Bytes(a.file),
        content_type: a.mime,
      }));
    }

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl('https://api.mailersend.com/v1/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiToken}`,
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
        | MailerSendErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    return {
      id: response.headers.get('x-message-id') ?? undefined,
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
 * Map MailerSend (HTTP status, error body) to canonical `ProviderCode` per
 * . MailerSend reports validation failures with HTTP 422
 * an `errors` object keyed by dotted field path (e.g., `from.email`,
 * `to.0.email`).
 */
function mapMailerSendErrorToProviderCode(
  status: number,
  body: MailerSendErrorResponse | null,
): ProviderCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';

  if (status === 422) {
    const fields = Object.keys(body?.errors ?? {});
    const hasRecipientField = fields.some(
      (f) => f === 'from.email' || f.startsWith('to.') || f.startsWith('cc.') || f.startsWith('bcc.') || f.startsWith('reply_to.'),
    );
    if (hasRecipientField) return 'invalid_recipient';
    if (fields.length > 0) return 'invalid_request';
    if (body?.message && /recipient|email address/i.test(body.message)) {
      return 'invalid_recipient';
    }
    return 'invalid_request';
  }

  if (status === 400) {
    return 'invalid_request';
  }

  return 'unknown';
}
