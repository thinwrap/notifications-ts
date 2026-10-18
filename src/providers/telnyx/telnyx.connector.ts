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
 * Classify a Telnyx synchronous error by `errors[0].code`, a numeric string
 * (https://developers.telnyx.com/development/api-fundamentals/api-errors).
 * Only the 403xx "API request" messaging codes and the 10xxx/20xxx platform
 * codes can appear in a send response; the 400xx delivery codes arrive only in
 * the async `message.finalized` webhook, so they are deliberately absent.
 * Titles: https://support.telnyx.com/en/articles/6505121-telnyx-messaging-error-codes
 */
function mapTelnyxCode(
  code: string,
  source: { pointer?: string } | undefined,
): ProviderCode | null {
  switch (code) {
    case '40300': // Blocked due to STOP message (recipient opted out)
    case '40309': // Invalid destination region
    case '40310': // Invalid 'to' address
      return 'invalid_recipient';
    case '10009': // Authentication failed
    case '10010': // Authorization failed
    case '20001': // Invalid API Key secret
    case '20006': // Expired access token
    case '40311': // Invalid messaging profile secret
    case '40313': // Missing messaging profile secret
      return 'auth_failed';
    case '10011': // Too many requests
    case '40318': // Message queue full
      return 'rate_limited';
    case '10002': // Invalid phone number: a recipient problem only when it points at `to`
      return source?.pointer === '/to' ? 'invalid_recipient' : 'invalid_request';
    case '10004': // Missing required parameter
    case '10015': // Bad Request
    case '20100': // Insufficient Funds
    case '40314': // Messaging disabled on account
    case '40316': // No content provided for message
    case '40317':
    case '40328':
    case '40331':
    case '40333':
      return 'invalid_request';
  }
  const n = Number(code);
  if ((n >= 40301 && n <= 40308) || (n >= 40319 && n <= 40325)) return 'invalid_request';
  return null;
}

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

    // A bare 422 is NOT a recipient signal: Telnyx returns it for any
    // unprocessable parameter, so only the vendor code can say "recipient".
    let providerCode: ProviderCode | null =
      errorCode !== undefined && errorCode !== null
        ? mapTelnyxCode(String(errorCode), firstError?.source)
        : null;
    if (providerCode === null) {
      if (statusCode === 401 || statusCode === 403) providerCode = 'auth_failed';
      else if (statusCode === 429) providerCode = 'rate_limited';
      else if (statusCode >= 500) providerCode = 'provider_unavailable';
      else if (statusCode >= 400) providerCode = 'invalid_request';
      else providerCode = 'unknown';
    }

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
  // Novu-compatible `sendMessage()` surface
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
