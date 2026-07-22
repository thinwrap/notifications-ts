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
import { encodeBase64Utf8, encodeBase64Bytes } from '../../utils';
import type { SendgridConfig } from './sendgrid.config';
import type { SendgridErrorResponse } from './sendgrid.types';

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

export class SendgridEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'sendgrid';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: SendgridConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   * Builds the SendGrid v3 `mail/send` JSON body in snake_case wire shape and
   * POSTs to `https://api.sendgrid.com/v3/mail/send` with `Authorization: Bearer
   * <apiKey>`. SendGrid is the canonical example: the connector explicitly
   * invokes `transformKeys(_passthrough.body, CasingEnum.SNAKE_CASE)` before
   * `mergePassthrough` so consumer-supplied camelCase keys (e.g.,
   * `dynamicTemplateData`) land as snake_case (`dynamic_template_data`) in the
   * wire body. Headers and query are HTTP-/URL-level and pass through verbatim.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const connectorBody = this.buildSendgridBody(input);

    // explicit per-connector casing-transform invocation on consumer's
    // `_passthrough.body`. Only keys are rewritten; values are passed verbatim
    // by the underlying utility.
    const normalizedPassthroughBody =
      input._passthrough?.body !== undefined
        ? (transformKeys(
            input._passthrough.body as Record<string, unknown>,
            CasingEnum.SNAKE_CASE,
            { deep: false },
          ) as Record<string, unknown>)
        : undefined;
    const normalizedPassthrough =
      input._passthrough && normalizedPassthroughBody !== undefined
        ? { ...input._passthrough, body: normalizedPassthroughBody }
        : input._passthrough;

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        normalizedPassthrough,
      );

    const url = SENDGRID_ENDPOINT;
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
        | SendgridErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    // SendGrid 202 Accepted carries an empty body; the message ID is in the
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
   * Build the SendGrid v3 `mail/send` wire body from Thinwrap's `EmailSendInput`.
   * Hand-mapped in snake_case (locality) — the hand-building IS the
   * casing transform for the connector-built portion of the body.
   */
  private buildSendgridBody(input: EmailSendInput): Record<string, unknown> {
    const fromAddress = input.from || this.config.from;
    const fromObject = this.config.senderName
      ? { email: fromAddress, name: this.config.senderName }
      : { email: fromAddress };

    const toAddresses = (Array.isArray(input.to) ? input.to : [input.to]).map(
      (e) => ({ email: e }),
    );
    const personalization: Record<string, unknown> = { to: toAddresses };
    if (input.cc && input.cc.length > 0) {
      personalization.cc = input.cc.map((e) => ({ email: e }));
    }
    if (input.bcc && input.bcc.length > 0) {
      personalization.bcc = input.bcc.map((e) => ({ email: e }));
    }

    const content: Array<{ type: string; value: string }> = [];
    if (input.text) content.push({ type: 'text/plain', value: input.text });
    if (input.html) content.push({ type: 'text/html', value: input.html });

    const body: Record<string, unknown> = {
      personalizations: [personalization],
      from: fromObject,
      subject: input.subject,
      content,
    };

    if (input.replyTo) body.reply_to = { email: input.replyTo };
    if (input.headers) body.headers = input.headers;
    if (input.tags && input.tags.length > 0) body.categories = input.tags;

    if (input.attachments && input.attachments.length > 0) {
      body.attachments = input.attachments.map((a) => {
        const contentBase64 =
          typeof a.content === 'string'
            ? encodeBase64Utf8(a.content)
            : encodeBase64Bytes(a.content);
        const att: Record<string, unknown> = {
          content: contentBase64,
          filename: a.filename,
        };
        if (a.contentType) att.type = a.contentType;
        if (a.contentId) {
          att.content_id = a.contentId;
          att.disposition = 'inline';
        }
        return att;
      });
    }

    return body;
  }

  /**
   * Map SendGrid error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header value on
   * `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    status: number,
    body: SendgridErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const firstError = body?.errors?.[0];
    const errorMessage = firstError?.message ?? '<no vendor message>';

    const providerCode = mapSendgridErrorToProviderCode(status, firstError);

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

    const personalization: Record<string, unknown> = {
      to: options.to.map((email) => ({ email })),
      subject: options.subject,
    };

    if (options.cc && options.cc.length > 0) {
      personalization.cc = options.cc.map((email) => ({ email }));
    }
    if (options.bcc && options.bcc.length > 0) {
      personalization.bcc = options.bcc.map((email) => ({ email }));
    }

    const payload: Record<string, unknown> = {
      personalizations: [personalization],
      from: senderName ? { email: from, name: senderName } : { email: from },
      content: [],
    };

    const content: { type: string; value: string }[] = [];
    if (options.text) content.push({ type: 'text/plain', value: options.text });
    if (options.html) content.push({ type: 'text/html', value: options.html });
    payload.content = content;

    if (options.replyTo) {
      payload.reply_to = { email: options.replyTo };
    }

    if (options.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments.map((a) => ({
        content: encodeBase64Bytes(a.file),
        type: a.mime,
        filename: a.name ?? 'attachment',
      }));
    }

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(
        'https://api.sendgrid.com/v3/mail/send',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
            ...passthroughHeaders,
          },
          body: JSON.stringify(body),
        }
      );
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
        | SendgridErrorResponse
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

/**
 * Map SendGrid (HTTP status, errors[0]) to canonical `ProviderCode` per Story
 * 1.11.
 */
function mapSendgridErrorToProviderCode(
  status: number,
  firstError: { message?: string; field?: string; help?: string } | undefined,
): ProviderCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  if (status === 413) return 'invalid_request';

  if (status === 400) {
    const field = firstError?.field ?? '';
    const message = firstError?.message ?? '';
    if (
      field.startsWith('personalizations') ||
      field === 'from.email' ||
      field === 'reply_to' ||
      field === 'reply_to.email'
    ) {
      return 'invalid_recipient';
    }
    if (/email address/i.test(message)) {
      return 'invalid_recipient';
    }
    return 'invalid_request';
  }

  return 'unknown';
}
