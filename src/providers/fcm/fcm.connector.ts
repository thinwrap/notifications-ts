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
import type { FcmConfig } from './fcm.config';
import type {
  FcmMessage,
  FcmSendRequest,
  FcmSendResponse,
  FcmErrorResponse,
  FcmPushSendInput,
} from './fcm.types';
import { getAccessToken } from './fcm.auth';

const TOKEN_CACHE_KEY_PREFIX = 'fcm:';

export class FcmPushConnector
  extends BaseConnector
  implements IPushProvider, IPushConnector
{
  public readonly id = 'fcm';
  public readonly channelType = ChannelTypeEnum.PUSH as ChannelTypeEnum.PUSH;

  // No instance state for tokens — the wrapper holds no state,
  // caching lives in the consumer-supplied `config.tokenCache` hook only.

  constructor(private config: FcmConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IPushConnector`.
   *
   * Auth flow:
   *   1. Resolve access token via `getAccessTokenViaHookOrFresh()` — either
   *      from the consumer's `tokenCache` hook (if supplied and unexpired)
   *      or by signing a fresh RS256 JWT and exchanging it at Google's
   *      OAuth 2.0 endpoint.
   *   2. POST `{ message: <FcmMessage> }` to
   *      https://fcm.googleapis.com/v1/projects/<projectId>/messages:send
   *      with `Authorization: Bearer <accessToken>`.
   *
   * Single-recipient enforcement: `input.to` is a single device
   * token. Topic-based delivery flows through `_passthrough.body.message.topic`.
   *
   * Error handling: vendor errors map to canonical `ConnectorError` via
   * `mapVendorError`. On vendor 401 the wrapper does NOT evict the hook
   * cache — eviction is the consumer's responsibility.
   */
  async send(input: FcmPushSendInput): Promise<PushSendResult> {
    const accessToken = await this.getAccessTokenViaHookOrFresh();

    const message = this.buildFcmMessage(input);

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        { message } as unknown as Record<string, unknown>,
        {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        input._passthrough,
      );

    const url =
      `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send` +
      buildQueryString(mergedQuery);

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
        | FcmErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as FcmSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.name ?? null,
      raw,
    };
  }

  /**
   * Resolve the FCM OAuth access token, going through the consumer's
   * `tokenCache` hook when configured:
   *
   * - No `tokenCache`: mint fresh on every call (the stateless default path).
   * - `tokenCache.get()` returns `{ token, expiresAt }` with `Date.now() < expiresAt`:
   *   reuse the cached token; do NOT call `mintFreshToken`; do NOT call `set`.
   * - `tokenCache.get()` returns null or a stale entry: mint fresh, then call
   *   `set(key, accessToken, Date.now() + expiresIn * 1000)`.
   *
   * The cache key is exactly `'fcm:' + projectId` — deterministic per-config,
   * not per-clientEmail. Vendor-rejection-of-cached-token eviction is the
   * consumer's responsibility (the wrapper holds no state).
   */
  private async getAccessTokenViaHookOrFresh(): Promise<string> {
    const cacheKey = `${TOKEN_CACHE_KEY_PREFIX}${this.config.projectId}`;

    if (this.config.tokenCache) {
      const cached = await this.config.tokenCache.get(cacheKey);
      if (cached !== null && Date.now() < cached.expiresAt) {
        return cached.token;
      }
    }

    const { accessToken, expiresInSeconds } = await getAccessToken(
      this.config.clientEmail,
      this.config.privateKey,
      this.fetchImpl,
    );

    if (this.config.tokenCache) {
      // Trust Google's reported expires_in verbatim. If the consumer wants a
      // safety margin, they wrap the hook with a shorter `expiresAt`.
      await this.config.tokenCache.set(
        cacheKey,
        accessToken,
        Date.now() + expiresInSeconds * 1000,
      );
    }

    return accessToken;
  }

  /**
   * Build an FCM HTTP v1 `Message` object from the narrowed `FcmPushSendInput`.
   * Field-mapping:
   * input.to → message.token (single recipient)
   *   input.title  → message.notification.title
   *   input.body   → message.notification.body
   *   input.data   → message.data (already constrained to Record<string, string>)
   *   input.ttl    → message.android.ttl = "<seconds>s" (FCM HTTP v1 wire shape)
   * Platform blocks (android, apns, webpush, fcm_options) forwarded verbatim.
   */
  private buildFcmMessage(input: FcmPushSendInput): FcmMessage {
    const message: FcmMessage = {
      token: input.to,
    };

    if (input.title !== undefined || input.body !== undefined) {
      message.notification = {};
      if (input.title !== undefined) message.notification.title = input.title;
      if (input.body !== undefined) message.notification.body = input.body;
    }

    if (input.data !== undefined) {
      message.data = input.data;
    }

    // input.ttl (seconds) folds into the android block when present.
    if (input.ttl !== undefined || input.android !== undefined) {
      const android: Record<string, unknown> = { ...(input.android ?? {}) };
      if (input.ttl !== undefined && android.ttl === undefined) {
        android.ttl = `${input.ttl}s`;
      }
      message.android = android;
    }

    if (input.apns !== undefined) {
      message.apns = input.apns as unknown as Record<string, unknown>;
    }

    if (input.webpush !== undefined) {
      message.webpush = input.webpush as unknown as Record<string, unknown>;
    }

    if (input.fcm_options !== undefined) {
      message.fcm_options = input.fcm_options as unknown as Record<string, unknown>;
    }

    return message;
  }

  /**
   * Map FCM HTTP v1 error responses to canonical `ConnectorError` with the
   * 6-value `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header
   * value on `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    status: number,
    body: FcmErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errorStatus = body?.error?.status ?? '';
    const errorMessage =
      body?.error?.message ?? `FCM HTTP ${status}`;

    const providerCode = mapFcmErrorToProviderCode(status, errorStatus);

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
    options: IPushOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    // The Novu surface keeps stateless signing — every call mints
    // a fresh token. Consumers wanting amortization use the Thinwrap-native
    // `.send()` surface with a `tokenCache` hook.
    const { accessToken } = await getAccessToken(
      this.config.clientEmail,
      this.config.privateKey,
      this.fetchImpl,
    );

    const overrides = options.overrides ?? {};
    const {
      type,
      android,
      apns,
      fcmOptions,
      webPush,
      data,
      tag,
      body,
      icon,
      badge,
      color,
      sound,
      title,
    } = overrides;

    const triggerPayload: Record<string, unknown> = {};
    if (type) triggerPayload.type = type;
    if (android) triggerPayload.android = android;
    if (apns) triggerPayload.apns = apns;
    if (fcmOptions) triggerPayload.fcmOptions = fcmOptions;
    if (webPush) triggerPayload.webPush = webPush;
    if (data) triggerPayload.data = data;
    if (tag) triggerPayload.tag = tag;
    if (body) triggerPayload.body = body;
    if (icon) triggerPayload.icon = icon;
    if (badge !== undefined) triggerPayload.badge = badge;
    if (color) triggerPayload.color = color;
    if (sound) triggerPayload.sound = sound;
    if (title) triggerPayload.title = title;

    const { body: transformedBody, headers: passthroughHeaders } = mergePassthrough(
      triggerPayload,
      {},
      bridgeProviderData._passthrough,
    );

    const sendUrl = `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`;

    const resolvedTitle = (transformedBody.title as string) ?? options.title;
    const content = (transformedBody.body as string) ?? options.content;
    const resolvedType = transformedBody.type as string | undefined;
    const resolvedAndroid = transformedBody.android as Record<string, unknown> | undefined;
    const resolvedApns = transformedBody.apns as Record<string, unknown> | undefined;
    const resolvedFcmOptions = transformedBody.fcm_options as Record<string, unknown> | undefined;
    const resolvedWebpush = transformedBody.web_push as Record<string, unknown> | undefined;
    const resolvedData = transformedBody.data as Record<string, string> | undefined;

    const postMessage = async (message: FcmMessage): Promise<FcmSendResponse> => {
      let response: Response;
      try {
        response = await this.fetchImpl(sendUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...passthroughHeaders,
          },
          body: JSON.stringify({ message } as FcmSendRequest),
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
          | FcmErrorResponse
          | null;
        throw this.mapVendorError(response.status, errBody, response.headers);
      }

      return (await response.json()) as FcmSendResponse;
    };

    // Check if topic-based delivery (set via passthrough)
    if (transformedBody.topic) {
      const message = this.buildLegacyMessage(
        undefined,
        transformedBody.topic as string,
        resolvedTitle,
        content,
        resolvedType,
        resolvedAndroid,
        resolvedApns,
        resolvedFcmOptions,
        resolvedWebpush,
        resolvedData,
        options.payload
      );

      const data = await postMessage(message);
      return {
        ids: [data.name],
        date: new Date().toISOString(),
      };
    }

    // Token-based delivery: one HTTP call per target token
    const results = await Promise.allSettled(
      options.target.map(async (deviceToken) => {
        const message = this.buildLegacyMessage(
          deviceToken,
          undefined,
          resolvedTitle,
          content,
          resolvedType,
          resolvedAndroid,
          resolvedApns,
          resolvedFcmOptions,
          resolvedWebpush,
          resolvedData,
          options.payload
        );

        const data = await postMessage(message);
        return data.name;
      })
    );

    const ids: string[] = [];
    let allFailed = true;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        ids.push(result.value);
        allFailed = false;
      } else {
        const err = result.reason;
        if (err instanceof ConnectorError) {
          ids.push(err.providerMessage ?? err.message);
        } else {
          ids.push((err as Error).message ?? 'Unknown error');
        }
      }
    }

    if (allFailed) {
      throw new ConnectorError({
        message: `All ${options.target.length} FCM message(s) failed to send`,
        statusCode: 500,
        providerMessage: ids.join('; '),
      });
    }

    return {
      ids,
      date: new Date().toISOString(),
    };
  }

  private buildLegacyMessage(
    deviceToken: string | undefined,
    topic: string | undefined,
    title: string,
    content: string,
    type: string | undefined,
    android: Record<string, unknown> | undefined,
    apns: Record<string, unknown> | undefined,
    fcmOptions: Record<string, unknown> | undefined,
    webpush: Record<string, unknown> | undefined,
    data: Record<string, string> | undefined,
    payload: object
  ): FcmMessage {
    const message: FcmMessage = {};

    if (deviceToken) {
      message.token = deviceToken;
    }

    if (topic) {
      message.topic = topic;
    }

    if (type === 'data') {
      message.data = {
        title,
        body: content,
        ...this.cleanPayload(payload),
        ...data,
      };
    } else {
      message.notification = {
        title,
        body: content,
      };

      const payloadData = this.cleanPayload(payload);
      if (data || Object.keys(payloadData).length > 0) {
        message.data = {
          ...payloadData,
          ...data,
        };
      }
    }

    if (android) {
      message.android = android;
    }

    if (apns) {
      message.apns = apns;
    }

    if (fcmOptions) {
      message.fcmOptions = fcmOptions;
    }

    if (webpush) {
      message.webpush = webpush;
    }

    return message;
  }

  private cleanPayload(payload: object): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string') {
        result[key] = value;
      } else {
        result[key] = JSON.stringify(value);
      }
    }

    return result;
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
 * Map FCM HTTP v1 (HTTP status, error.status string) to canonical `ProviderCode`.
 *
 *   401 UNAUTHENTICATED      → auth_failed
 *   400 INVALID_ARGUMENT     → invalid_request
 *   404 NOT_FOUND            → invalid_recipient (unregistered device token)
 *   403 SENDER_ID_MISMATCH   → auth_failed
 *   429 QUOTA_EXCEEDED       → rate_limited
 *   503 UNAVAILABLE          → provider_unavailable
 *   500 INTERNAL             → provider_unavailable
 *   * other                  → unknown
 */
function mapFcmErrorToProviderCode(
  status: number,
  fcmStatus: string,
): ProviderCode {
  if (status === 401) return 'auth_failed';
  if (status === 403) return 'auth_failed';
  if (status === 404) return 'invalid_recipient';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'provider_unavailable';
  if (status === 500) return 'provider_unavailable';
  if (status === 400) return 'invalid_request';

  // Fallback: vendor `error.status` string may disambiguate when HTTP status
  // is non-canonical (proxies, edge cases).
  if (fcmStatus === 'UNAUTHENTICATED' || fcmStatus === 'SENDER_ID_MISMATCH') {
    return 'auth_failed';
  }
  if (fcmStatus === 'INVALID_ARGUMENT') return 'invalid_request';
  if (fcmStatus === 'NOT_FOUND') return 'invalid_recipient';
  if (fcmStatus === 'QUOTA_EXCEEDED' || fcmStatus === 'RESOURCE_EXHAUSTED') {
    return 'rate_limited';
  }
  if (fcmStatus === 'UNAVAILABLE' || fcmStatus === 'INTERNAL') {
    return 'provider_unavailable';
  }

  return 'unknown';
}
