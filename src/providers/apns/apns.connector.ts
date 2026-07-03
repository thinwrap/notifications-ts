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
import type { ApnsConfig } from './apns.config';
import type {
  ApnsPushSendInput,
  ApnsErrorResponse,
  ApnsPayload,
} from './apns.types';
import { createApnsJwt } from './apns.auth';

const TOKEN_CACHE_KEY_PREFIX = 'apns:';
/** Apple's documented max JWT validity is ~60 minutes; 50-min TTL leaves 10-min safety margin. */
const JWT_CACHE_TTL_MS = 50 * 60 * 1000;

export class ApnsPushConnector
  extends BaseConnector
  implements IPushProvider, IPushConnector
{
  public readonly id = 'apns';
  public readonly channelType = ChannelTypeEnum.PUSH as ChannelTypeEnum.PUSH;

  // No instance state for tokens — the wrapper holds no state,
  // caching lives in the consumer-supplied `config.tokenCache` hook only.

  constructor(private config: ApnsConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IPushConnector`.
   *
   * Auth flow:
   *   1. Resolve JWT via `getJwtViaHookOrFresh()` — either from the
   *      consumer's `tokenCache` hook (if supplied and unexpired) or by
   *      signing a fresh ES256 JWT via `createApnsJwt`.
   *   2. POST to `https://api.push.apple.com/3/device/<token>` (prod) or
   *      `https://api.sandbox.push.apple.com/3/device/<token>` (sandbox).
   *
   * HTTP/2: APNs requires HTTP/2. Node 18+ `fetch` (undici) negotiates HTTP/2
   * via ALPN automatically when the server supports it (Path A). This keeps
   * APNs on the BYO-fetch contract.
   *
   * Single-recipient enforcement: `input.to` is the device token.
   *
   * Error handling: vendor errors map to canonical `ConnectorError` via
   * `mapVendorError`. On vendor 403 + `InvalidProviderToken` the wrapper
   * does NOT evict the hook cache — eviction is the consumer's responsibility.
   */
  async send(input: ApnsPushSendInput): Promise<PushSendResult> {
    const jwt = await this.getJwtViaHookOrFresh();

    const wireBody = this.buildApnsBody(input);
    const connectorHeaders = this.buildApnsHeaders(input, jwt);

    const { body: mergedBody, headers: mergedHeaders } = mergePassthrough(
      wireBody as unknown as Record<string, unknown>,
      connectorHeaders,
      input._passthrough,
    );

    const host =
      this.config.env === 'production'
        ? 'api.push.apple.com'
        : 'api.sandbox.push.apple.com';
    const url = `https://${host}/3/device/${encodeURIComponent(input.to)}`;

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
        | ApnsErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    // APNs returns an empty body on 200; the canonical message ID is the
    // `apns-id` response header (UUID assigned by APNs).
    return {
      success: true,
      status: 'sent',
      providerMessageId: response.headers.get('apns-id'),
      raw: {},
    };
  }

  /**
   * Resolve the APNs ES256 JWT, going through the consumer's `tokenCache`
   * hook when configured:
   *
   * - No `tokenCache`: sign fresh on every call (the stateless default).
   * - `tokenCache.get()` returns `{ token, expiresAt }` with `Date.now() < expiresAt`:
   *   reuse the cached token; do NOT call `createApnsJwt`; do NOT call `set`.
   * - `tokenCache.get()` returns null or a stale entry: sign fresh, then call
   *   `set(key, jwt, Date.now() + 50 * 60 * 1000)`.
   *
   * The cache key is exactly `'apns:<teamId>:<keyId>:<bundleId>'` — fully
   * deterministic per-config; multiple apps/keys/teams in one process do not
   * collide. Vendor-rejection-of-cached-token eviction is the consumer's
   * responsibility (the wrapper holds no state).
   */
  private async getJwtViaHookOrFresh(): Promise<string> {
    const cacheKey = `${TOKEN_CACHE_KEY_PREFIX}${this.config.teamId}:${this.config.keyId}:${this.config.bundleId}`;

    if (this.config.tokenCache) {
      const cached = await this.config.tokenCache.get(cacheKey);
      if (cached !== null && Date.now() < cached.expiresAt) {
        return cached.token;
      }
    }

    const jwt = createApnsJwt(
      this.config.keyId,
      this.config.teamId,
      this.config.privateKey,
    );

    if (this.config.tokenCache) {
      await this.config.tokenCache.set(
        cacheKey,
        jwt,
        Date.now() + JWT_CACHE_TTL_MS,
      );
    }

    return jwt;
  }

  /**
   * Build the APNs JSON request body from the narrowed `ApnsPushSendInput`.
   * Field-mapping table:
   *
   *   input.title/body/subtitle    → aps.alert.{title,body,subtitle}
   *   input.sound                  → aps.sound
   *   input.badge                  → aps.badge
   *   input.aps (rest)             → merged into aps verbatim (kebab-case preserved)
   *   input.data                   → merged at root (custom keys per Apple spec)
   */
  private buildApnsBody(input: ApnsPushSendInput): ApnsPayload {
    const aps: ApnsPayload['aps'] = {};

    if (
      input.title !== undefined ||
      input.body !== undefined ||
      input.aps?.alert !== undefined
    ) {
      const alert: { title?: string; body?: string; subtitle?: string } = {
        ...(input.aps?.alert ?? {}),
      };
      if (input.title !== undefined) alert.title = input.title;
      if (input.body !== undefined) alert.body = input.body;
      aps.alert = alert;
    }

    if (input.sound !== undefined) aps.sound = input.sound;
    if (input.badge !== undefined) aps.badge = input.badge;

    if (input.aps) {
      // Merge remaining kebab-case aps keys verbatim (alert already handled).
      const { alert: _alert, ...restAps } = input.aps;
      Object.assign(aps, restAps);
    }

    const payload: ApnsPayload = { aps };

    if (input.data) {
      // APNs spec: custom data keys merge at the root of the payload, alongside `aps`.
      Object.assign(payload, input.data);
    }

    return payload;
  }

  /**
   * Build the per-request APNs HTTP/2 headers. Authorization, apns-topic,
   * apns-push-type are always present. apns-priority / apns-expiration /
   * apns-collapse-id are emitted only when the consumer set them.
   */
  private buildApnsHeaders(
    input: ApnsPushSendInput,
    jwt: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      'apns-topic': input.apnsTopic ?? this.config.bundleId,
      'apns-push-type':
        input.apnsPushType ??
        (input.title !== undefined || input.body !== undefined
          ? 'alert'
          : 'background'),
      'content-type': 'application/json',
    };

    if (input.apnsPriority !== undefined) {
      headers['apns-priority'] = String(input.apnsPriority);
    }
    if (input.apnsCollapseId !== undefined) {
      headers['apns-collapse-id'] = input.apnsCollapseId;
    }
    if (input.ttl !== undefined) {
      headers['apns-expiration'] = String(
        Math.floor(Date.now() / 1000) + input.ttl,
      );
    } else if (input.apnsExpiration !== undefined) {
      headers['apns-expiration'] = String(input.apnsExpiration);
    }

    return headers;
  }

  /**
   * Map APNs error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header
   * value on `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   *
   * APNs does not always emit `Retry-After` on 429/503 (Apple's documented
   * backpressure signal is HTTP/2 stream reset; `Retry-After` is best-effort).
   * When absent, `cause.retryAfter` is `null` and no parenthetical is appended.
   */
  private mapVendorError(
    status: number,
    body: ApnsErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const reason = body?.reason ?? '';
    const message = reason || `APNs HTTP ${status}`;

    const providerCode = mapApnsErrorToProviderCode(status, reason);

    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    return new ConnectorError({
      message,
      statusCode: status,
      providerCode,
      providerMessage: message,
      cause,
    });
  }

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  /**
   * Preserved Novu-shaped surface. Like the FCM brownfield surface, this
   * mints a fresh JWT on every call (stateless). Consumers
   * wanting amortization use the Thinwrap-native `.send()` surface with a
   * `tokenCache` hook.
   *
   * the canonical `.send()` surface is single-recipient; this
   * brownfield surface preserves multi-target dispatch via `Promise.allSettled`
   * for backward compatibility with the original ts-notification-connectors
   * IPushProvider contract.
   */
  async sendMessage(
    options: IPushOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {},
  ): Promise<ISendMessageSuccessResponse> {
    const jwt = createApnsJwt(
      this.config.keyId,
      this.config.teamId,
      this.config.privateKey,
    );

    const overrides = options.overrides ?? {};

    const apnsPayload: ApnsPayload = {
      aps: {
        alert: {
          title: (overrides.title as string | undefined) ?? options.title,
          body: (overrides.body as string | undefined) ?? options.content,
        },
      },
    };

    if (overrides.sound !== undefined) {
      apnsPayload.aps.sound = overrides.sound as string;
    }
    if (overrides.badge !== undefined) {
      apnsPayload.aps.badge = overrides.badge as number;
    }

    if (options.payload) {
      for (const [key, value] of Object.entries(options.payload)) {
        apnsPayload[key] = value;
      }
    }

    const { body: transformedPayload, headers: passthroughHeaders } = mergePassthrough(
      apnsPayload as unknown as Record<string, unknown>,
      {},
      bridgeProviderData._passthrough,
    );

    const host =
      this.config.env === 'production'
        ? 'api.push.apple.com'
        : 'api.sandbox.push.apple.com';

    const results = await Promise.allSettled(
      options.target.map(async (deviceToken) => {
        const url = `https://${host}/3/device/${encodeURIComponent(deviceToken)}`;
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: 'POST',
            headers: {
              authorization: `bearer ${jwt}`,
              'apns-topic': this.config.bundleId,
              'apns-push-type': 'alert',
              'content-type': 'application/json',
              ...passthroughHeaders,
            },
            body: JSON.stringify(transformedPayload),
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
            | ApnsErrorResponse
            | null;
          throw this.mapVendorError(response.status, errBody, response.headers);
        }

        return response.headers.get('apns-id') ?? '';
      }),
    );

    const ids: string[] = [];
    let allFailed = true;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        ids.push(result.value);
        allFailed = false;
      } else {
        const err = result.reason;
        ids.push(
          err instanceof ConnectorError
            ? err.providerMessage ?? err.message
            : (err as Error).message ?? 'Unknown error',
        );
      }
    }

    if (allFailed) {
      throw new ConnectorError({
        message: `All ${options.target.length} APNs message(s) failed to send`,
        statusCode: 500,
        providerMessage: ids.join('; '),
      });
    }

    return {
      ids,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Map APNs (HTTP status, response `reason` field) to canonical `ProviderCode`.
 *
 *   400 BadDeviceToken                                  → invalid_recipient
 *   400 other (PayloadTooLarge/BadTopic/...)            → invalid_request
 *   403 BadDeviceToken                                  → invalid_recipient
 *   403 InvalidProviderToken/Missing.../Expired...      → auth_failed
 *   410 Unregistered                                    → invalid_recipient
 *   413 PayloadTooLarge                                 → invalid_request
 *   429 TooManyRequests                                 → rate_limited
 *   500 InternalServerError                             → provider_unavailable
 *   503 ServiceUnavailable / Shutdown                   → provider_unavailable
 *   other                                               → unknown
 */
function mapApnsErrorToProviderCode(
  status: number,
  reason: string,
): ProviderCode {
  if (status === 400) {
    if (reason === 'BadDeviceToken') return 'invalid_recipient';
    return 'invalid_request';
  }
  if (status === 403) {
    if (reason === 'BadDeviceToken') return 'invalid_recipient';
    if (
      reason === 'InvalidProviderToken' ||
      reason === 'MissingProviderToken' ||
      reason === 'ExpiredProviderToken'
    ) {
      return 'auth_failed';
    }
    return 'auth_failed';
  }
  if (status === 410) return 'invalid_recipient';
  if (status === 413) return 'invalid_request';
  if (status === 429) return 'rate_limited';
  if (status === 500) return 'provider_unavailable';
  if (status === 503) return 'provider_unavailable';
  return 'unknown';
}

