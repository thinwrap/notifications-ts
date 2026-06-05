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
import type { SinchConfig } from './sinch.config';
import type { SinchNarrowedInput, SinchSendResponse } from './sinch.types';

/**
 * Build the regional batches endpoint. Sinch exposes two clusters today (`us`
 * and `eu`); the region is a subdomain prefix, no host map is required.
 */
function sinchBatchesUrl(region: 'us' | 'eu', servicePlanId: string): string {
  return `https://${region}.sms.api.sinch.com/xms/v1/${servicePlanId}/batches`;
}

export class SinchSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'sinch';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: SinchConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * Builds a JSON body in snake_case (explicit casing — no `transformKeys`
   * invocation since each key is written by hand) and POSTs to the regional
   * batches endpoint `https://<region>.sms.api.sinch.com/xms/v1/<servicePlanId>/batches`.
   *
   * Sinch's batches API expects `to: string[]` even for single-recipient sends;
   * the connector wraps `[input.to]` automatically. Multi-recipient batches are
   * out of v1.0 Thinwrap baseline — consumers can override
   * `_passthrough.body.to`.
   */
  async send(input: SinchNarrowedInput): Promise<SmsSendResult> {
    const from = input.from ?? this.config.from;
    if (!from) {
      throw new ConnectorError({
        message: 'Sinch requires `from` in either input.from or config.from.',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Sinch requires `from` in either input.from or config.from.',
      });
    }

    const connectorBody: Record<string, unknown> = {
      from,
      to: [input.to],
      body: input.body,
    };
    if (input.type !== undefined) connectorBody.type = input.type;
    if (input.parameters !== undefined) connectorBody.parameters = input.parameters;
    if (input.deliveryReport !== undefined)
      connectorBody.delivery_report = input.deliveryReport;
    if (input.sendAt !== undefined) connectorBody.send_at = input.sendAt;
    if (input.expireAt !== undefined) connectorBody.expire_at = input.expireAt;
    if (input.callbackUrl !== undefined)
      connectorBody.callback_url = input.callbackUrl;
    if (input.clientReference !== undefined)
      connectorBody.client_reference = input.clientReference;
    if (input.feedbackEnabled !== undefined)
      connectorBody.feedback_enabled = input.feedbackEnabled;
    if (input.flashMessage !== undefined)
      connectorBody.flash_message = input.flashMessage;

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiToken}`,
        },
        input._passthrough,
      );

    const region = this.config.region ?? 'us';
    const baseUrl = sinchBatchesUrl(region, this.config.servicePlanId);
    const url =
      Object.keys(mergedQuery).length > 0
        ? `${baseUrl}?${new URLSearchParams(mergedQuery).toString()}`
        : baseUrl;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
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
        | { text?: string; code?: string }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as SinchSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.id ?? null,
      raw,
    };
  }

  /**
   * Map Sinch error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header value on
   * `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    statusCode: number,
    body: { text?: string; code?: string } | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const text = body?.text;
    const code = body?.code;

    let providerCode: ProviderCode;
    if (statusCode === 401 || statusCode === 403) {
      providerCode = 'auth_failed';
    } else if (statusCode === 429) {
      providerCode = 'rate_limited';
    } else if (statusCode >= 500) {
      providerCode = 'provider_unavailable';
    } else if (
      code === 'invalid_destination' ||
      code === 'invalid_recipient'
    ) {
      providerCode = 'invalid_recipient';
    } else if (statusCode >= 400) {
      providerCode = 'invalid_request';
    } else {
      providerCode = 'unknown';
    }

    const baseMessage = text ?? `Sinch HTTP ${statusCode}`;

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
      to: [options.to],
      body: options.content,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const region = this.config.region ?? 'us';
    const url = sinchBatchesUrl(region, this.config.servicePlanId);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
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
        | { text?: string; code?: string }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as SinchSendResponse;
    return {
      id: data.id,
      date: new Date().toISOString(),
    };
  }
}
