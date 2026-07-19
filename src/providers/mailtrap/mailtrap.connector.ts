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
import type { MailtrapConfig } from './mailtrap.config';
import type {
  MailtrapSendResponse,
  MailtrapErrorResponse,
} from './mailtrap.types';

const MAILTRAP_PRODUCTION_ENDPOINT = 'https://send.api.mailtrap.io/api/send';
const MAILTRAP_SANDBOX_HOST = 'https://sandbox.api.mailtrap.io/api/send';

export class MailtrapEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'mailtrap';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: MailtrapConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
    // Mailtrap is unique among v1.0 connectors in running a synchronous config
    // validator at construction time. The `mode` field has runtime safety
    // implications (sandbox vs. production endpoint), so misconfigurations are
    // surfaced before the first `.send()` call rather than deep in some test
    // run. See the inline note "Config Validation — Why at Construction Time".
    this.validateConfig();
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   * Builds the Mailtrap send-email JSON body in snake_case wire shape and POSTs
   * to one of two endpoints depending on `config.mode`:
   *
   *   - `'sandbox'`    → `https://sandbox.api.mailtrap.io/api/send/<inboxId>`
   *                      (captures the email in the Mailtrap inbox UI, does not
   *                      deliver to the recipient)
   *   - `'production'` → `https://send.api.mailtrap.io/api/send`
   *                      (actually delivers email)
   *
   * Auth: `Authorization: Bearer <apiToken>`. the connector
   * explicitly invokes `transformKeys(_passthrough.body, CasingEnum.SNAKE_CASE)`
   * so consumer-supplied camelCase keys (e.g., `templateUuid`,
   * `templateVariables`, `customVariables`, `category`) land as snake_case in
   * the wire body.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    // Mailtrap does not support tags at v1.0; consumer must use
    // `_passthrough.body.category` instead. Throw early before any wire work.
    if (input.tags && input.tags.length > 0) {
      throw new ConnectorError({
        message:
          'Mailtrap does not support tags at v1.0; use _passthrough.body.category instead',
        statusCode: null,
        providerCode: 'invalid_request',
      });
    }

    const url = this.resolveEndpoint();
    const connectorBody = this.buildMailtrapBody(input);

    // explicit per-connector casing-transform invocation on consumer's
    // `_passthrough.body`. Only keys are rewritten; values are passed verbatim.
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
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.apiToken}`,
        },
        normalizedPassthrough,
      );

    const queryString = buildQueryString(mergedQuery);
    const fullUrl = `${url}${queryString}`;
    const serializedBody = JSON.stringify(mergedBody);

    let response: Response;
    try {
      response = await this.fetchImpl(fullUrl, {
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
        | MailtrapErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json().catch(() => null)) as
      | MailtrapSendResponse
      | null;

    return {
      success: true,
      status: 'sent',
      providerMessageId: raw?.message_ids?.[0] ?? null,
      raw: (raw ?? {}) as Record<string, unknown>,
    };
  }

  /**
   * Build the Mailtrap wire body from Thinwrap's `EmailSendInput`. Hand-mapped
   * in snake_case (locality): `from`/`to`/`cc`/`bcc` become
   * `{ email, name? }` objects; `replyTo` becomes a single `reply_to` object
   * (not an array — Mailtrap differs from MailerSend here); `headers` is passed
   * through as a `Record<string,string>` (Mailtrap accepts that shape natively,
   * unlike Postmark/MailerSend which require an Array<{name,value}>).
   */
  private buildMailtrapBody(input: EmailSendInput): Record<string, unknown> {
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
      body.reply_to = { email: input.replyTo };
    }
    if (input.html) body.html = input.html;
    if (input.text) body.text = input.text;

    if (input.headers) {
      // Mailtrap accepts a flat Record directly (no array reshape needed).
      body.headers = { ...input.headers };
    }

    if (input.attachments && input.attachments.length > 0) {
      body.attachments = input.attachments.map((a) => {
        const contentBase64 =
          typeof a.content === 'string'
            ? encodeBase64Utf8(a.content)
            : encodeBase64Bytes(a.content);
        const att: Record<string, unknown> = {
          filename: a.filename,
          content: contentBase64,
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
   * Map Mailtrap error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header value on
   * `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    status: number,
    body: MailtrapErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errors = body?.errors ?? [];
    const errorMessage =
      errors.length > 0 ? errors.join('; ') : '<no vendor message>';

    const providerCode = mapMailtrapErrorToProviderCode(status, errors);

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

  /**
   * Synchronous constructor-time validator. Throws `ConnectorError` if the
   * `mode` `inboxId` combination is invalid. See.
   */
  private validateConfig(): void {
    const { mode, inboxId } = this.config;
    if (mode !== 'sandbox' && mode !== 'production') {
      throw new ConnectorError({
        message: `Mailtrap config.mode must be 'sandbox' or 'production'; got ${JSON.stringify(mode)}`,
        statusCode: 0,
        providerCode: 'invalid_request',
        providerMessage: `Mailtrap config.mode must be 'sandbox' or 'production'; got ${JSON.stringify(mode)}`,
      });
    }
    if (mode === 'sandbox' && !inboxId) {
      throw new ConnectorError({
        message: 'Mailtrap sandbox mode requires inboxId in config',
        statusCode: 0,
        providerCode: 'invalid_request',
        providerMessage: 'Mailtrap sandbox mode requires inboxId in config',
      });
    }
    if (mode === 'production' && inboxId) {
      throw new ConnectorError({
        message:
          'Mailtrap production mode forbids inboxId in config (it is sandbox-only)',
        statusCode: 0,
        providerCode: 'invalid_request',
        providerMessage:
          'Mailtrap production mode forbids inboxId in config (it is sandbox-only)',
      });
    }
  }

  /**
   * Resolve the Mailtrap endpoint for the current config. Sandbox URLs embed
   * the inbox id in the path; production uses a single global host.
   */
  private resolveEndpoint(): string {
    if (this.config.mode === 'sandbox') {
      // `validateConfig()` guarantees `inboxId` is set when mode is sandbox.
      return `${MAILTRAP_SANDBOX_HOST}/${encodeURIComponent(this.config.inboxId as string)}`;
    }
    return MAILTRAP_PRODUCTION_ENDPOINT;
  }

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IEmailOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    // Mailtrap does not support tags at v1.0. The brownfield surface
    // doesn't carry tags directly, but reject them if present via _passthrough.body.tags.
    const ptTags = (bridgeProviderData._passthrough?.body as Record<string, unknown> | undefined)?.tags;
    if (Array.isArray(ptTags) && ptTags.length > 0) {
      throw new ConnectorError({
        message:
          'Mailtrap does not support tags at v1.0; use _passthrough.body.category instead',
        statusCode: null,
        providerCode: 'invalid_request',
      });
    }

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

    if (options.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments.map((a) => ({
        filename: a.name ?? 'attachment',
        content: encodeBase64Bytes(a.file),
        type: a.mime,
      }));
    }

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(this.resolveEndpoint(), {
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
        | MailtrapErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as MailtrapSendResponse;
    return {
      id: data.message_ids[0],
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
 * Map Mailtrap (HTTP status, errors[] array) to canonical `ProviderCode` per
 * . Mailtrap reports validation failures with HTTP 400 or 422
 * and a string array `errors[]`. Recipient detection scans each entry for
 * /recipient|email|to|from address/.
 */
function mapMailtrapErrorToProviderCode(
  status: number,
  errors: string[],
): ProviderCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';

  const hasRecipientPhrase = errors.some((e) =>
    /recipient|email|to |from address/i.test(e),
  );

  if (status === 422) {
    if (hasRecipientPhrase) return 'invalid_recipient';
    return 'invalid_request';
  }
  if (status === 400) {
    if (hasRecipientPhrase) return 'invalid_recipient';
    return 'invalid_request';
  }

  return 'unknown';
}
