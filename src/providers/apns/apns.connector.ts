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
import { allTargetsFailedError, mergePassthrough } from '../../utils';
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

  /**
   * True when NO transport was injected — i.e. we fall back to the built-in
   * `globalThis.fetch` (undici), which speaks HTTP/1.1 only. APNs mandates
   * HTTP/2, so that combination can never succeed; we fail fast (below) rather
   * than emit an opaque transport error. A consumer-injected `fetch` may be
   * HTTP/2-capable, so we do NOT block that case.
   */
  private readonly usesDefaultTransport: boolean;

  constructor(private config: ApnsConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
    this.usesDefaultTransport = fetchImpl === undefined && config.fetch === undefined;
  }

  /**
   * APNs requires HTTP/2. Node's built-in `fetch` (undici) is HTTP/1.1-only, so
   * if the consumer injected no `fetch` we cannot succeed — surface a clear,
   * typed error up front instead of a confusing network failure mid-request.
   */
  private assertHttp2Transport(): void {
    if (this.usesDefaultTransport) {
      const message =
        'APNs requires HTTP/2, but no HTTP/2-capable transport was provided. ' +
        "Node's built-in fetch (undici) speaks only HTTP/1.1. Pass an HTTP/2-capable " +
        '`fetch` via ApnsConfig.fetch (e.g. one backed by an HTTP/2 client).';
      throw new ConnectorError({
        message,
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: message,
      });
    }
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
   * HTTP/2: APNs requires HTTP/2. Node's built-in `fetch` (undici) is
   * HTTP/1.1-ONLY — it does NOT transparently negotiate HTTP/2 — so a consumer
   * that injects no `fetch` cannot reach APNs; `assertHttp2Transport()` fails
   * fast in that case. An HTTP/2-capable `fetch` must be provided via
   * `ApnsConfig.fetch` (BYO-fetch contract).
   *
   * Single-recipient enforcement: `input.to` is the device token.
   *
   * Error handling: vendor errors map to canonical `ConnectorError` via
   * `mapVendorError`. On vendor 403 + `InvalidProviderToken` the wrapper
   * does NOT evict the hook cache — eviction is the consumer's responsibility.
   */
  async send(input: ApnsPushSendInput): Promise<PushSendResult> {
    this.assertHttp2Transport();
    const jwt = await this.getJwtViaHookOrFresh();

    const wireBody = this.buildApnsBody(input);
    const connectorHeaders = this.buildApnsHeaders(input, jwt);

    const { body: mergedBody, headers: mergedHeaders } = mergePassthrough(
      wireBody as unknown as Record<string, unknown>,
      connectorHeaders,
      input._passthrough,
    );
    finalizePushType(mergedBody, mergedHeaders);

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
      const typedAlert = input.aps?.alert;
      if (typeof typedAlert === 'string' && input.title === undefined && input.body === undefined) {
        // Apple allows `alert` as a plain string (the body text): send it
        // verbatim. Spreading it would produce `{"0":"H","1":"i",…}`.
        aps.alert = typedAlert;
      } else {
        const alert: { title?: string; body?: string; subtitle?: string } =
          typeof typedAlert === 'string' ? { body: typedAlert } : { ...(typedAlert ?? {}) };
        if (input.title !== undefined) alert.title = input.title;
        if (input.body !== undefined) alert.body = input.body;
        aps.alert = alert;
      }
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
      // APNs spec: custom data keys merge at the root of the payload, alongside
      // `aps`. Guard the reserved `aps` key so consumer data can never clobber
      // the constructed alert/badge/sound dict (use `_passthrough` to shape aps).
      const { aps: _reservedAps, ...customData } = input.data as Record<
        string,
        unknown
      >;
      Object.assign(payload, customData);
    }

    return payload;
  }

  /**
   * Build the per-request APNs HTTP/2 headers. Authorization and apns-topic
   * are always present; apns-push-type is set here only when the caller chose
   * it, otherwise {@link finalizePushType} infers it from the merged body.
   * apns-priority / apns-expiration / apns-collapse-id are emitted only when
   * the consumer set them (plus the priority 5 a background push requires).
   */
  private buildApnsHeaders(
    input: ApnsPushSendInput,
    jwt: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      'apns-topic': input.apnsTopic ?? this.config.bundleId,
      'content-type': 'application/json',
    };
    if (input.apnsPushType !== undefined) headers['apns-push-type'] = input.apnsPushType;

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
    // Apple: "Update the authentication token no more than once every 20
    // minutes." A stateless wrapper mints a new JWT per call, so the only fix
    // is a shared `tokenCache`; the message says so.
    const message =
      status === 429 && reason === TOO_MANY_TOKEN_UPDATES
        ? `${reason}: APNs accepts a new provider token at most once every 20 minutes. ` +
          'Supply ApnsConfig.tokenCache (shared across connector instances) so the JWT is reused.'
        : reason || `APNs HTTP ${status}`;

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
  // Novu-compatible `sendMessage()` surface
  // ---------------------------------------------------------------------------

  /**
   * Resolves the JWT through `config.tokenCache` exactly like `.send()`: APNs
   * rejects a provider token that changes more than once per 20 minutes, so
   * this surface must not mint its own.
   *
   * Unlike `.send()`, which is single-recipient, this dispatches to multiple targets
   * via `Promise.allSettled` to match the Novu `IPushProvider` contract.
   */
  async sendMessage(
    options: IPushOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {},
  ): Promise<ISendMessageSuccessResponse> {
    this.assertHttp2Transport();
    const jwt = await this.getJwtViaHookOrFresh();

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

    const { body: transformedPayload, headers: requestHeaders } = mergePassthrough(
      apnsPayload as unknown as Record<string, unknown>,
      {
        authorization: `bearer ${jwt}`,
        'apns-topic': this.config.bundleId,
        'content-type': 'application/json',
      },
      bridgeProviderData._passthrough,
    );
    finalizePushType(transformedPayload, requestHeaders);

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
            headers: requestHeaders,
            body: JSON.stringify(transformedPayload),
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
            | ApnsErrorResponse
            | null;
          throw this.mapVendorError(response.status, errBody, response.headers);
        }

        return response.headers.get('apns-id') ?? '';
      }),
    );

    const ids: string[] = [];
    const reasons: unknown[] = [];
    let allFailed = true;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        ids.push(result.value);
        allFailed = false;
      } else {
        const err = result.reason;
        reasons.push(err);
        ids.push(
          err instanceof ConnectorError
            ? err.providerMessage ?? err.message
            : (err as Error).message ?? 'Unknown error',
        );
      }
    }

    if (allFailed) throw allTargetsFailedError('APNs', reasons, ids);

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
 * https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
 *
 *   400 BadDeviceToken                                  → invalid_recipient
 *   400 other (PayloadTooLarge/BadTopic/...)            → invalid_request
 *   403 BadDeviceToken                                  → invalid_recipient
 *   403 InvalidProviderToken/Missing.../Expired...      → auth_failed
 *   410 Unregistered                                    → invalid_recipient
 *   413 PayloadTooLarge                                 → invalid_request
 *   429 TooManyProviderTokenUpdates                     → auth_failed
 *   429 TooManyRequests                                 → rate_limited
 *   5xx InternalServerError / ServiceUnavailable / ...  → provider_unavailable
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
    return 'auth_failed';
  }
  if (status === 410) return 'invalid_recipient';
  if (status === 413) return 'invalid_request';
  // Retrying does not clear this one: without a shared token cache every
  // retry mints another new JWT and re-triggers it.
  if (status === 429 && reason === TOO_MANY_TOKEN_UPDATES) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

const TOO_MANY_TOKEN_UPDATES = 'TooManyProviderTokenUpdates';

/**
 * Resolve `apns-push-type` from the MERGED body when the caller did not set
 * it (typed field or passthrough header), and apply what Apple requires of a
 * background push. From "sending-notification-requests-to-apns": for
 * `background`, "Always use priority 5. Using priority 10 is an error", and an
 * omitted `apns-priority` defaults to 10. "pushing-background-updates-to-your-app":
 * the `aps` dictionary "includes only the content-available key".
 *
 * Inference looks at `aps.alert` / `aps.badge` / `aps.sound` in the merged
 * body, so one supplied only through `input.aps` or `_passthrough.body.aps`
 * still makes the push an `alert`.
 */
function finalizePushType(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): void {
  const existing = findHeader(headers, 'apns-push-type');
  let pushType: string;
  if (existing !== undefined) {
    pushType = headers[existing]!;
  } else {
    const aps = isRecord(body.aps) ? body.aps : undefined;
    // Apple: `alert` is "the push type for notifications that trigger a user
    // interaction—for example, an alert, badge, or sound". A badge- or
    // sound-only push is therefore an alert push, not a silent one.
    const interactive =
      aps !== undefined && (aps.alert !== undefined || aps.badge !== undefined || aps.sound !== undefined);
    pushType = interactive ? 'alert' : 'background';
    headers['apns-push-type'] = pushType;
  }

  if (pushType !== 'background') return;
  if (findHeader(headers, 'apns-priority') === undefined) headers['apns-priority'] = '5';
  const aps = isRecord(body.aps) ? body.aps : {};
  if (aps['content-available'] === undefined) aps['content-available'] = 1;
  body.aps = aps;
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  return Object.keys(headers).find((k) => k.toLowerCase() === name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
