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
import type { TelnyxConfig } from './telnyx.config';
import type {
  TelnyxNarrowedInput,
  TelnyxSendResponse,
  TelnyxErrorResponse,
} from './telnyx.types';

const TELNYX_ENDPOINT = 'https://api.telnyx.com/v2/messages';

/**
 * Telnyx error `code` strings (from `errors[0].code`) that should map to
 * `invalid_recipient` rather than the generic `invalid_request`. Telnyx's
 * typed-error surface lets us disambiguate.
 */
const TELNYX_INVALID_RECIPIENT_CODES: ReadonlySet<string> = new Set([
  'to_number_invalid',
  'messaging_profile_id_not_found',
  'no_to_number_provided',
]);

export class TelnyxSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'telnyx';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: TelnyxConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * Builds a JSON body, authenticates with `Authorization: Bearer <apiKey>`,
   * and POSTs to `https://api.telnyx.com/v2/messages`.
   *
   * Telnyx wire keys are snake_case (`messaging_profile_id`, `webhook_url`,
   * `auto_detect`, `media_urls`). these are written explicitly in
   * the `connectorBody` literal rather than invoking a casing transform.
   *
   * Telnyx wraps successful responses in a JSON:API `{ data: {...} }`
   * envelope; the connector unwraps once for `providerMessageId` and
   * preserves the full envelope in `raw`.
   */
  async send(input: TelnyxNarrowedInput): Promise<SmsSendResult> {
    const from = input.from ?? this.config.from;
    if (!from && !input.messagingProfileId) {
      throw new ConnectorError({
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Telnyx requires `from`, `config.from`, or `messagingProfileId`.',
      });
    }

    const connectorBody: Record<string, unknown> = {
      to: input.to,
      text: input.body,
    };
    if (from) connectorBody.from = from;
    if (input.messagingProfileId)
      connectorBody.messaging_profile_id = input.messagingProfileId;
    if (input.webhookUrl) connectorBody.webhook_url = input.webhookUrl;
    if (input.webhookFailoverUrl)
      connectorBody.webhook_failover_url = input.webhookFailoverUrl;
    if (input.useProfileWebhooks !== undefined)
      connectorBody.use_profile_webhooks = input.useProfileWebhooks;
    if (input.type) connectorBody.type = input.type;
    if (input.autoDetect !== undefined)
      connectorBody.auto_detect = input.autoDetect;
    if (input.mediaUrls) connectorBody.media_urls = input.mediaUrls;
    if (input.subject) connectorBody.subject = input.subject;

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        input._passthrough,
      );

    let response: Response;
    try {
      response = await this.fetchImpl(TELNYX_ENDPOINT, {
        method: 'POST',
        headers: mergedHeaders,
        body: JSON.stringify(mergedBody),
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
        | TelnyxErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as TelnyxSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.data?.id ?? null,
      raw,
    };
  }

  /**
   * Map Telnyx error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header
   * value on `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    statusCode: number,
    body: TelnyxErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const firstError = body?.errors?.[0];
    const errorCode = firstError?.code;
    const errorDetail = firstError?.detail ?? firstError?.title;

    let providerCode: ProviderCode;
    if (statusCode === 401 || statusCode === 403) providerCode = 'auth_failed';
    else if (statusCode === 429) providerCode = 'rate_limited';
    else if (statusCode >= 500) providerCode = 'provider_unavailable';
    else if (
      statusCode === 422 ||
      (errorCode !== undefined && TELNYX_INVALID_RECIPIENT_CODES.has(errorCode))
    )
      providerCode = 'invalid_recipient';
    else if (statusCode >= 400) providerCode = 'invalid_request';
    else providerCode = 'unknown';

    const baseMessage = errorDetail ?? `Telnyx HTTP ${statusCode}`;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    return new ConnectorError({
      message: baseMessage,
      statusCode,
      providerCode,
      providerMessage: baseMessage,
      cause,
    });
  }

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: ISmsOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const payload: Record<string, unknown> = {
      from: options.from ?? this.config.from,
      to: options.to,
      text: options.content,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(TELNYX_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
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
        | TelnyxErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as TelnyxSendResponse;
    return {
      id: data.data.id,
      date: new Date().toISOString(),
    };
  }
}
