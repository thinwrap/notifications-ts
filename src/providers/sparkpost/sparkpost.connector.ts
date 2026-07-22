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
import type { SparkPostConfig } from './sparkpost.config';
import type {
  SparkPostRecipient,
  SparkPostSendResponse,
  SparkPostErrorResponse,
} from './sparkpost.types';

const SPARKPOST_US_BASE = 'https://api.sparkpost.com';
const SPARKPOST_EU_BASE = 'https://api.eu.sparkpost.com';
const SPARKPOST_TRANSMISSIONS_PATH = '/api/v1/transmissions';

// =============================================================================
// CANONICAL EXAMPLE: SparkPost CC/BCC outlier translation locality.
// -----------------------------------------------------------------------------
// SparkPost's `/api/v1/transmissions` endpoint does NOT take separate cc/bcc
// fields. Instead, every CC and BCC recipient is appended to `recipients[]`
// with `address.header_to` pointing at the primary `to` address. This routes
// the email through SparkPost's per-recipient pipeline while making the
// recipient's email client display the message as addressed to the primary
// `to`. CC visibility (the recipient seeing the CC list) is achieved by also
// setting `content.headers.CC` to the comma-joined cc list. BCC stays
// invisible — `content.headers.BCC` is never written.
//
// This transform lives HERE in the connector, outlier-locality.
// There is no shared CC/BCC normalizer middleware. Other connectors that hit
// a similar single-provider wire-shape divergence copy this pattern.
// =============================================================================

export class SparkPostEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'sparkpost';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: SparkPostConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   * Builds the SparkPost `transmissions` JSON body (with nested
   * `recipients`/`content`/`options` envelopes in snake_case wire shape) and
   * POSTs to `https://api.sparkpost.com/api/v1/transmissions` (or the EU
   * regional endpoint).
   *
   * Auth: `Authorization: <apiKey>` — SparkPost is an outlier in NOT using a
   * `Bearer ` prefix; the raw key is sent verbatim.
   *
   * the connector explicitly invokes
   * `transformKeys(_passthrough.body, CasingEnum.SNAKE_CASE)` so
   * consumer-supplied camelCase keys (e.g., `campaignId`, `substitutionData`)
   * land as snake_case in the wire body.
   *
   * On 2xx, SparkPost may still report all recipients as rejected via
   * `results.total_accepted_recipients === 0`; this is surfaced as a
   * thrown `ConnectorError providerCode: 'invalid_recipient'` so consumers
   * handle it the same way as a 400-with-bad-recipient from other providers.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const url = this.resolveEndpoint();
    const connectorBody = this.buildSparkPostBody(input);

    // explicit per-connector casing-transform invocation on consumer's
    // `_passthrough.body`. Only keys are rewritten; values pass verbatim.
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
          Accept: 'application/json',
          // SparkPost auth is the RAW key — no `Bearer` or `Basic` prefix.
          Authorization: this.config.apiKey,
        },
        normalizedPassthrough,
      );

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
        | SparkPostErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json().catch(() => null)) as
      | SparkPostSendResponse
      | null;

    // 200 with all recipients rejected is treated as a failure. Per
    // Per the >=90% baseline-coverage rule, we surface this via
    // `invalid_recipient` so consumers handle it like a 4xx from other
    // providers.
    if (
      raw?.results &&
      raw.results.total_accepted_recipients === 0 &&
      (raw.results.total_rejected_recipients ?? 0) > 0
    ) {
      throw new ConnectorError({
        message: 'SparkPost rejected all recipients',
        statusCode: response.status,
        providerCode: 'invalid_recipient',
        providerMessage: `total_rejected_recipients=${raw.results.total_rejected_recipients}, total_accepted_recipients=0`,
        cause: raw,
      });
    }

    return {
      success: true,
      status: 'queued',
      providerMessageId: raw?.results?.id ?? null,
      raw: (raw ?? {}) as Record<string, unknown>,
    };
  }

  /**
   * Resolve the SparkPost endpoint for the current config. Returns the US base
   * unless `region === 'eu'`.
   */
  private resolveEndpoint(): string {
    const baseUrl =
      this.config.region === 'eu' ? SPARKPOST_EU_BASE : SPARKPOST_US_BASE;
    return `${baseUrl}${SPARKPOST_TRANSMISSIONS_PATH}`;
  }

  /**
   * Build the SparkPost wire body from Thinwrap's `EmailSendInput`. Assembles
   * `recipients[]` (via `buildRecipientsArray`) and `content` (subject, from,
   * html/text, reply_to, headers, attachments, inline_images). Tags are
   * mapped to `metadata.tags` as the default convention; consumers can
   * override via `_passthrough.body.metadata`.
   */
  private buildSparkPostBody(input: EmailSendInput): Record<string, unknown> {
    const recipients = this.buildRecipientsArray(input);

    const fromAddress = input.from || this.config.from;
    const fromObject = this.config.senderName
      ? { email: fromAddress, name: this.config.senderName }
      : { email: fromAddress };

    const content: Record<string, unknown> = {
      from: fromObject,
      subject: input.subject,
    };

    if (input.html) content.html = input.html;
    if (input.text) content.text = input.text;
    // SparkPost takes reply_to as a string, not an object.
    if (input.replyTo) content.reply_to = input.replyTo;

    // Headers: user-supplied + CC visibility (BCC stays invisible).
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    if (input.cc && input.cc.length > 0) {
      // Comma-join makes the CC list visible to all recipients.
      headers.CC = input.cc.join(', ');
    }
    // Intentionally NOT writing headers.BCC — BCC recipients receive via
    // `recipients[]`+`header_to` but stay invisible.
    if (Object.keys(headers).length > 0) content.headers = headers;

    // Attachments: SparkPost splits attachments and inline images into two
    // separate fields. Items with `contentId` go to `inline_images`; others
    // go to `attachments`.
    if (input.attachments && input.attachments.length > 0) {
      const attachments: Array<Record<string, unknown>> = [];
      const inlineImages: Array<Record<string, unknown>> = [];
      for (const a of input.attachments) {
        const contentBase64 =
          typeof a.content === 'string'
            ? encodeBase64Utf8(a.content)
            : encodeBase64Bytes(a.content);
        const item: Record<string, unknown> = {
          name: a.filename,
          data: contentBase64,
        };
        if (a.contentType) item.type = a.contentType;
        if (a.contentId) inlineImages.push(item);
        else attachments.push(item);
      }
      if (attachments.length > 0) content.attachments = attachments;
      if (inlineImages.length > 0) content.inline_images = inlineImages;
    }

    const body: Record<string, unknown> = { recipients, content };

    if (input.tags && input.tags.length > 0) {
      // SparkPost has no top-level `tags` field; the standard convention is
      // `metadata.tags`. Consumers can override via `_passthrough.body.metadata`.
      body.metadata = { tags: input.tags };
    }

    return body;
  }

  /**
   * canonical transform: build SparkPost's `recipients[]` array from
   * `EmailSendInput.{to,cc,bcc}`. Primary `to` recipients are added without
   * `header_to`; each cc and bcc recipient is appended as a separate entry
   * with `address.header_to: <primary to>` so the recipient's email client
   * displays the message as addressed to the primary `to`.
   */
  private buildRecipientsArray(input: EmailSendInput): SparkPostRecipient[] {
    const toList = Array.isArray(input.to) ? input.to : [input.to];
    const primaryTo = toList[0]!;

    const recipients: SparkPostRecipient[] = toList.map((email) => ({
      address: { email },
    }));

    if (input.cc && input.cc.length > 0) {
      for (const email of input.cc) {
        recipients.push({ address: { email, header_to: primaryTo } });
      }
    }

    if (input.bcc && input.bcc.length > 0) {
      for (const email of input.bcc) {
        recipients.push({ address: { email, header_to: primaryTo } });
      }
    }

    return recipients;
  }

  /**
   * Map SparkPost error responses to canonical `ConnectorError` with the
   * 6-value `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw
   * header value on `cause.retryAfter`. No structured `retryAfterSeconds`
   * field — retry is consumer policy.
   */
  private mapVendorError(
    status: number,
    body: SparkPostErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const firstError = body?.errors?.[0];
    const errorMessage = firstError?.message ?? '<no vendor message>';

    const providerCode = mapSparkPostErrorToProviderCode(status, firstError);

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

    const recipients = options.to.map((email) => ({
      address: { email },
    }));

    if (options.cc && options.cc.length > 0) {
      for (const email of options.cc) {
        recipients.push({ address: { email } });
      }
    }
    if (options.bcc && options.bcc.length > 0) {
      for (const email of options.bcc) {
        recipients.push({ address: { email } });
      }
    }

    const content: Record<string, unknown> = {
      from: senderName
        ? { email: from, name: senderName }
        : { email: from },
      subject: options.subject,
    };

    if (options.html) content.html = options.html;
    if (options.text) content.text = options.text;
    if (options.replyTo) content.reply_to = options.replyTo;

    if (options.attachments && options.attachments.length > 0) {
      content.attachments = options.attachments.map((a) => ({
        name: a.name ?? 'attachment',
        type: a.mime,
        data: encodeBase64Bytes(a.file),
      }));
    }

    const payload: Record<string, unknown> = {
      recipients,
      content,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const baseUrl =
      this.config.region === 'eu'
        ? SPARKPOST_EU_BASE
        : SPARKPOST_US_BASE;

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${SPARKPOST_TRANSMISSIONS_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.config.apiKey,
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
        | SparkPostErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as SparkPostSendResponse;
    return {
      id: data.results.id,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Map SparkPost (HTTP status, errors[0]) to canonical `ProviderCode` per
 * .
 */
function mapSparkPostErrorToProviderCode(
  status: number,
  firstError: { message?: string; code?: string; description?: string } | undefined,
): ProviderCode {
  if (status === 401 || status === 403 || status === 420) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  if (status === 413) return 'invalid_request';
  if (status === 422) return 'invalid_request';

  if (status === 400) {
    const message = firstError?.message ?? '';
    const code = firstError?.code ?? '';
    if (/recipient|address/i.test(message)) return 'invalid_recipient';
    if (code === '1300' || code === '1301' || code === '1303') {
      return 'invalid_recipient';
    }
    return 'invalid_request';
  }

  return 'unknown';
}
