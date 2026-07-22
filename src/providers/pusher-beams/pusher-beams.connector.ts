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
import type { PusherBeamsConfig } from './pusher-beams.config';
import type {
  PusherBeamsErrorResponse,
  PusherBeamsPushSendInput,
  PusherBeamsSendResponse,
} from './pusher-beams.types';

/**
 * Pusher Beams push connector.
 *
 * **Canonical outlier example.** Beams requires
 * the publisher to send BOTH an FCM-formatted payload AND an APNs-formatted
 * payload in the same request (plus optionally a Web push payload). Beams'
 * server fans those payloads out to subscribed devices based on each
 * device's registered token type.
 *
 * To preserve Thinwrap's uniform `PushSendInput` base shape, this
 * connector synthesizes the nested platform payloads inside its `.send()`
 * method via the private `synthesizeWirePayload()` helper. The synthesis
 * lives **here, in the connector file** — not in `src/utils/` or
 * `src/base/` — following the "outlier wire-translation locality" discipline.
 */
export class PusherBeamsPushConnector
  extends BaseConnector
  implements IPushProvider, IPushConnector
{
  public readonly id = 'pusher-beams' as const;
  public readonly channelType = ChannelTypeEnum.PUSH as ChannelTypeEnum.PUSH;

  constructor(private config: PusherBeamsConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IPushConnector`.
   *
   * Routing precedence:
   *   1. `input.interests` set → `/publishes/interests`, body has `interests`.
   *   2. `input.users` set → `/publishes/users`, body has the supplied users array.
   *   3. Default → `/publishes/users`, body has `users: [input.to]`.
   *
   * Auth: `Authorization: Bearer <secretKey>` (long-lived static secret —
   * no token signing, no caching).
   *
   * Errors map to canonical `ConnectorError` via `mapVendorError`. Per
   * Retry is consumer policy (no retryAfterSeconds field), no
   * structured `retryAfterSeconds` field — parsed seconds embedded in
   * `providerMessage` text, raw header on `cause.retryAfter`.
   */
  async send(input: PusherBeamsPushSendInput): Promise<PushSendResult> {
    const connectorBody = this.synthesizeWirePayload(input);
    const connectorHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.secretKey}`,
    };

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        connectorHeaders,
        input._passthrough,
      );

    const endpointSuffix =
      input.interests !== undefined ? 'interests' : 'users';
    const baseUrl =
      `https://${this.config.instanceId}.pushnotifications.pusher.com` +
      `/publish_api/v1/instances/${this.config.instanceId}` +
      `/publishes/${endpointSuffix}`;

    let response: Response;
    try {
      response = await this.fetchImpl(baseUrl, {
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
        | PusherBeamsErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as PusherBeamsSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.publishId ?? null,
      raw,
    };
  }

  /**
   * ** outlier synthesis — canonical TS example.**
   *
   * Build the Beams wire body from the base `PushSendInput` fields. The
   * synthesis assembles three parallel platform payloads (`fcm`, `apns`,
   * `web`) and merges in any consumer-supplied augmentations via shallow
   * spread. Beams' server fans the request out to subscribed devices.
   *
   * Why connector-local: Beams is the only push provider in
   * v1.0 with this requirement. A shared "wire translator" middleware
   * would be a generic-abstraction trap. Maintainers reading this file
   * see the entire request construction in one place.
   */
  private synthesizeWirePayload(
    input: PusherBeamsPushSendInput,
  ): Record<string, unknown> {
    const title = input.title;
    const body = input.body;

    // FCM (Android) payload — Beams nests this under `fcm`.
    const fcmPayload: Record<string, unknown> = {
      notification: { title, body },
    };
    if (input.data !== undefined) {
      // FCM wire constraint: data values must be strings.
      fcmPayload.data = stringifyValues(input.data);
    }
    if (input.ttl !== undefined) {
      fcmPayload.android = { ttl: `${input.ttl}s` };
    }

    // APNs (iOS) payload — Beams nests this under `apns`.
    const apsBlock: Record<string, unknown> = { alert: { title, body } };
    if (input.badge !== undefined) apsBlock.badge = input.badge;
    if (input.sound !== undefined) apsBlock.sound = input.sound;
    const apnsPayload: Record<string, unknown> = { aps: apsBlock };
    if (input.ttl !== undefined) {
      apnsPayload['apns-expiration'] =
        Math.floor(Date.now() / 1000) + input.ttl;
    }

    // Optional Web push payload. Web preserves original `data` types.
    const webPayload: Record<string, unknown> = {
      notification: { title, body },
    };
    if (input.data !== undefined) webPayload.data = input.data;

    const wire: Record<string, unknown> = {
      fcm: fcmPayload,
      apns: apnsPayload,
      web: webPayload,
    };

    // Recipient routing (precedence: interests > users array > [input.to]).
    if (input.interests !== undefined) {
      wire.interests = input.interests;
    } else if (input.users !== undefined) {
      wire.users = input.users;
    } else {
      wire.users = [input.to];
    }

    // Augmentation overrides — shallow merge wins on key collisions.
    if (input.fcm !== undefined) {
      wire.fcm = { ...(wire.fcm as Record<string, unknown>), ...input.fcm };
    }
    if (input.apns !== undefined) {
      const merged: Record<string, unknown> = {
        ...(wire.apns as Record<string, unknown>),
        ...input.apns,
      };
      // Shallow merge of `aps` so synthesized `alert`/`badge`/`sound`
      // survive when consumer only overrides a sibling key.
      if (
        (wire.apns as Record<string, unknown>).aps &&
        (input.apns as Record<string, unknown>).aps
      ) {
        merged.aps = {
          ...((wire.apns as Record<string, unknown>).aps as Record<
            string,
            unknown
          >),
          ...((input.apns as Record<string, unknown>).aps as Record<
            string,
            unknown
          >),
        };
      }
      wire.apns = merged;
    }
    if (input.web !== undefined) {
      wire.web = { ...(wire.web as Record<string, unknown>), ...input.web };
    }

    return wire;
  }

  /**
   * Map Pusher Beams HTTP error responses to canonical `ConnectorError`
   * . Beams' error body shape is `{ error: string, description?: string }`.
   *
   * Retry-After surfacing
   * Retry is consumer policy (no retryAfterSeconds field): parsed seconds appended to
   * `providerMessage` text; raw header on `cause.retryAfter`. No structured
   * `retryAfterSeconds` field on `ConnectorError`.
   */
  private mapVendorError(
    status: number,
    body: PusherBeamsErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const providerCode = mapPusherBeamsStatusToProviderCode(status);

    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const baseMessage = body?.error ?? `Pusher Beams ${status}`;

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
    const body = overrides.body ?? options.content;

    const payload: Record<string, unknown> = {
      users: options.target,
      fcm: {
        notification: { title, body },
      },
      apns: {
        aps: {
          alert: { title, body },
        },
      },
      web: {
        notification: { title, body },
      },
    };

    if (options.payload && Object.keys(options.payload).length > 0) {
      (payload.fcm as Record<string, unknown>).data = options.payload;
    }

    const { body: transformedBody, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const url = `https://${this.config.instanceId}.pushnotifications.pusher.com/publish_api/v1/instances/${this.config.instanceId}/publishes/users`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.secretKey}`,
          ...passthroughHeaders,
        },
        body: JSON.stringify(transformedBody),
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
        | PusherBeamsErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as PusherBeamsSendResponse;
    return {
      id: data.publishId,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * FCM wire constraint: all `data` values must be strings. Non-string
 * values are JSON-stringified. Module-local — this
 * helper is Beams-synthesis-specific and does NOT belong in `src/utils/`.
 */
function stringifyValues(
  o: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * Map Pusher Beams HTTP status to canonical `ProviderCode`.
 *
 *   401              → auth_failed       (bad secret key)
 *   400              → invalid_request   (malformed JSON, missing required fields)
 *   422              → invalid_recipient (invalid interest/user, no subscribers)
 *   429              → rate_limited
 *   500 / 503        → provider_unavailable
 *   *                → unknown
 */
function mapPusherBeamsStatusToProviderCode(status: number): ProviderCode {
  if (status === 401) return 'auth_failed';
  if (status === 400) return 'invalid_request';
  if (status === 422) return 'invalid_recipient';
  if (status === 429) return 'rate_limited';
  if (status === 500 || status === 503) return 'provider_unavailable';
  return 'unknown';
}
