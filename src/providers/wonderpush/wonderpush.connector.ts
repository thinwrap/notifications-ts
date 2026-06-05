import { BaseConnector } from '../../base/base.connector';
import type {
  IPushOptions,
  IPushProvider,
  ISendMessageSuccessResponse,
  WithPassthrough,
  PushSendResult,
  IPushConnector,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import type { WonderPushConfig } from './wonderpush.config';
import type {
  WonderPushNarrowedInput,
  WonderPushSendResponse,
} from './wonderpush.types';

const WONDERPUSH_ENDPOINT = 'https://management-api.wonderpush.com/v1/deliveries';

export class WonderPushPushConnector
  extends BaseConnector
  implements IPushProvider, IPushConnector
{
  public readonly id = 'wonderpush' as const;
  public readonly channelType = ChannelTypeEnum.PUSH as ChannelTypeEnum.PUSH;

  // No instance state — stateless Bearer-auth sender.

  constructor(private config: WonderPushConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IPushConnector`.
   *
   * Wire shape (per WonderPush Management API `/v1/deliveries`):
   *   - `Authorization: Bearer <accessToken>` header (no query-param auth).
   *   - `Content-Type: application/json` body.
   *   - Body fields: `applicationId?`, `targetUserIds`, `targetSegmentIds?`,
   *     `customSegmentation?`, plus a structured `notification` object.
   *
   * Recipient routing (per-connector augmentation):
   *   - Default: `targetUserIds = [input.to]`.
   *   - `input.targetUserIds` (augmentation) overrides the default.
   *   - `input.targetSegmentIds` flows through verbatim and may coexist.
   *
   * Error handling: vendor errors map to canonical `ConnectorError` via
   * `mapVendorError`. Retry-After is informational only
   * — parsed seconds in `providerMessage` text, raw header value
   * on `cause.retryAfter`. No structured `retryAfterSeconds` field.
   */
  async send(input: WonderPushNarrowedInput): Promise<PushSendResult> {
    const connectorBody = this.buildRequestBody(input);

    const connectorHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.accessToken}`,
    };

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        connectorHeaders,
        input._passthrough,
      );

    const finalUrl =
      Object.keys(mergedQuery).length > 0
        ? `${WONDERPUSH_ENDPOINT}?${new URLSearchParams(mergedQuery).toString()}`
        : WONDERPUSH_ENDPOINT;

    let response: Response;
    try {
      response = await this.fetchImpl(finalUrl, {
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
        | { error?: { code?: number; message?: string; status?: string } }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as WonderPushSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.id ?? raw.notificationId ?? null,
      raw,
    };
  }

  /**
   * Build the canonical WonderPush deliveries body. Strips `undefined` values
   * so the wire payload stays compact.
   */
  private buildRequestBody(input: WonderPushNarrowedInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    if (this.config.applicationId !== undefined) {
      body.applicationId = this.config.applicationId;
    }

    // Recipient routing: augmentation `targetUserIds` wins over `[input.to]`.
    body.targetUserIds = input.targetUserIds ?? [input.to];

    if (input.targetSegmentIds !== undefined) {
      body.targetSegmentIds = input.targetSegmentIds;
    }
    if (input.customSegmentation !== undefined) {
      body.customSegmentation = input.customSegmentation;
    }

    // notification block — merge augmentation override on top of field-level defaults.
    const alert: Record<string, unknown> = {};
    if (input.title !== undefined) alert.title = input.title;
    if (input.body !== undefined) alert.text = input.body;
    if (input.subtitle !== undefined) alert.subtitle = input.subtitle;

    const notification: Record<string, unknown> = {};
    if (Object.keys(alert).length > 0) notification.alert = alert;
    if (input.sound !== undefined) notification.sound = input.sound;
    if (input.badge !== undefined) notification.badge = input.badge;
    if (input.data !== undefined) notification.custom = input.data;

    if (input.notification !== undefined) {
      // Augmentation-supplied `notification` overrides field-level defaults at the leaf level.
      Object.assign(notification, input.notification);
      if (
        input.notification.alert !== undefined &&
        Object.keys(alert).length > 0
      ) {
        notification.alert = { ...alert, ...input.notification.alert };
      }
    }

    if (Object.keys(notification).length > 0) {
      body.notification = notification;
    }

    if (input.actions !== undefined) body.actions = input.actions;
    if (input.categories !== undefined) body.categories = input.categories;

    return body;
  }

  /**
   * HTTP-layer mapping. Parses `Retry-After` and embeds
   * the parsed seconds in `providerMessage` text; raw header value attached
   * to `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field) — the wrapper performs no retry.
   *
   * WonderPush vendor error shape: `{ error: { code, message, status } }`.
   */
  private mapVendorError(
    status: number,
    body: { error?: { code?: number; message?: string; status?: string } } | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const providerCode: ProviderCode = mapStatusToProviderCode(status);
    const baseMessage = body?.error?.message ?? `WonderPush HTTP ${status}`;

    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    return new ConnectorError({
      message: baseMessage,
      statusCode: status,
      providerCode,
      providerMessage: baseMessage,
      cause,
    });
  }

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IPushOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const overrides = options.overrides ?? {};

    const title = overrides.title ?? options.title;
    const content = overrides.body ?? options.content;

    const notification = JSON.stringify({
      alert: { title, text: content },
    });

    const payload: Record<string, unknown> = {
      targetUserIds: options.target.join(','),
      notification,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      params.append(key, String(value));
    }

    //  (security): pass accessToken in Authorization header rather than URL
    // query — prevents credential leaks via access logs / referrer headers.
    const url = WONDERPUSH_ENDPOINT;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${this.config.accessToken}`,
          ...passthroughHeaders,
        },
        body: params.toString(),
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
        | { error?: { code?: number; message?: string; status?: string } }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as WonderPushSendResponse;
    return {
      id: data.notificationId ?? data.id ?? '',
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function mapStatusToProviderCode(status: number): ProviderCode {
  if (status === 401) return 'auth_failed';
  if (status === 404) return 'invalid_recipient';
  if (status === 429) return 'rate_limited';
  if (status === 500 || status === 503) return 'provider_unavailable';
  if (status === 400) return 'invalid_request';
  if (status >= 400 && status < 500) return 'invalid_request';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}
