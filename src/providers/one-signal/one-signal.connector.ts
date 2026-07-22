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
import type { OneSignalConfig } from './one-signal.config';
import type {
  OneSignalNarrowedInput,
  OneSignalSendResponse,
} from './one-signal.types';

const ONE_SIGNAL_ENDPOINT =
  'https://onesignal.com/api/v1/notifications';

/**
 * Marker substrings used by OneSignal's 200-with-errors path. When the
 * response body's `errors` array contains any of these (case-insensitive
 * substring match) we map to `invalid_recipient`.
 */
const INVALID_RECIPIENT_ERROR_MARKERS = [
  'all included players are not subscribed',
  'invalid_player_ids',
  'invalid_external_user_ids',
  'no subscriptions',
];

export class OneSignalPushConnector
  extends BaseConnector
  implements IPushProvider, IPushConnector
{
  public readonly id = 'one-signal';
  public readonly channelType = ChannelTypeEnum.PUSH as ChannelTypeEnum.PUSH;

  constructor(private config: OneSignalConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IPushConnector`.
   *
   * Wire body construction (-5):
   *   - `app_id` from config
   *   - `headings: { en: input.title }` (overridable via augmentation `headings`)
   *   - `contents: { en: input.body }` (overridable via augmentation `contents`)
   *   - Recipient routing: by default `include_subscription_ids: [input.to]`.
   *     Any augmentation recipient field (`include_external_user_ids`,
   *     `include_player_ids`, `included_segments`, `excluded_segments`)
   *     wins — when set, `include_subscription_ids` is omitted entirely.
   *   - Augmentation fields forwarded verbatim (snake_case literals).
   *
   * Auth: `Authorization: Basic <restApiKey>` per OneSignal REST API v1
   * (the REST API key is the credential portion; no base64 wrapping).
   *
   * Response handling (-7): HTTP 200 with `id` and no error markers ->
   * success. HTTP 200 with `errors` array carrying an invalid-recipient
   * marker -> `ConnectorError({ providerCode: 'invalid_recipient' })`.
   * HTTP 200 with `errors` as an object (`invalid_external_user_ids: [...]`)
   * -> same. Missing `id` on 200 -> `invalid_request`.
   */
  async send(input: OneSignalNarrowedInput): Promise<PushSendResult> {
    const connectorBody = this.buildBody(input);

    const connectorHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Basic ${this.config.apiKey}`,
    };

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        connectorHeaders,
        input._passthrough,
      );

    let response: Response;
    try {
      response = await this.fetchImpl(ONE_SIGNAL_ENDPOINT, {
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
        | OneSignalSendResponse
        | { errors?: unknown; message?: string }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as OneSignalSendResponse;

    // 200-with-errors path: OneSignal returns HTTP 200 even when all
    // recipients are invalid. Inspect `errors` and map.
    if (raw.errors !== undefined) {
      const ticketError = this.mapTicketError(raw, response.status);
      if (ticketError) throw ticketError;
    }

    if (!raw.id) {
      throw new ConnectorError({
        message: 'OneSignal returned no notification id',
        statusCode: response.status,
        providerCode: 'invalid_request',
        providerMessage: 'OneSignal returned no notification id',
        cause: { raw },
      });
    }

    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.id,
      raw,
    };
  }

  /**
   * Build the OneSignal wire body from the narrowed input. Snake-case wire
   * field names are spelled directly (no `CasingEnum.SNAKE_CASE` transform).
   */
  private buildBody(input: OneSignalNarrowedInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      app_id: this.config.appId,
    };

    // Recipient routing — augmentation fields win over base `input.to`.
    const hasAugmentationRecipient =
      input.include_external_user_ids !== undefined ||
      input.include_player_ids !== undefined ||
      input.included_segments !== undefined ||
      input.excluded_segments !== undefined;

    if (hasAugmentationRecipient) {
      if (input.include_external_user_ids !== undefined) {
        body.include_external_user_ids = input.include_external_user_ids;
      }
      if (input.include_player_ids !== undefined) {
        body.include_player_ids = input.include_player_ids;
      }
      if (input.included_segments !== undefined) {
        body.included_segments = input.included_segments;
      }
      if (input.excluded_segments !== undefined) {
        body.excluded_segments = input.excluded_segments;
      }
    } else if (input.to !== undefined) {
      body.include_subscription_ids = [input.to];
    }

    // Title / body — augmentation localized maps win over base singletons.
    if (input.headings !== undefined) {
      body.headings = input.headings;
    } else if (input.title !== undefined) {
      body.headings = { en: input.title };
    }

    if (input.contents !== undefined) {
      body.contents = input.contents;
    } else if (input.body !== undefined) {
      body.contents = { en: input.body };
    }

    if (input.data !== undefined) body.data = input.data;
    if (input.ttl !== undefined) body.ttl = input.ttl;
    if (input.priority !== undefined) body.priority = input.priority;
    if (input.ios_attachments !== undefined)
      body.ios_attachments = input.ios_attachments;
    if (input.big_picture !== undefined) body.big_picture = input.big_picture;
    if (input.android_channel_id !== undefined)
      body.android_channel_id = input.android_channel_id;
    if (input.ios_sound !== undefined) body.ios_sound = input.ios_sound;
    if (input.android_sound !== undefined)
      body.android_sound = input.android_sound;
    if (input.send_after !== undefined) body.send_after = input.send_after;
    if (input.delayed_option !== undefined)
      body.delayed_option = input.delayed_option;
    if (input.external_id !== undefined) body.external_id = input.external_id;
    if (input.collapse_id !== undefined) body.collapse_id = input.collapse_id;

    return body;
  }

  /**
   * Body-layer mapping: HTTP 200 with an `errors` field. OneSignal documents
   * two shapes — string array (`['All included players are not subscribed']`)
   * and object map (`{ invalid_external_user_ids: [...] }`). Both indicate
   * invalid recipients on the wrapper's canonical surface.
   *
   * Returns `null` when the `errors` field is present but does not match any
   * known invalid-recipient marker — the caller treats this as success.
   */
  private mapTicketError(
    raw: OneSignalSendResponse,
    httpStatus: number,
  ): ConnectorError | null {
    const errors = raw.errors;
    if (errors === undefined) return null;

    let firstMessage = '';
    let isInvalidRecipient = false;

    if (Array.isArray(errors)) {
      firstMessage = errors[0] ?? '';
      isInvalidRecipient = errors.some((e) =>
        typeof e === 'string'
          ? INVALID_RECIPIENT_ERROR_MARKERS.some((m) =>
              e.toLowerCase().includes(m),
            )
          : false,
      );
    } else if (errors !== null && typeof errors === 'object') {
      // Object shape: invalid_external_user_ids / invalid_player_ids /
      // invalid_aliases all signal an invalid-recipient outcome.
      const hasInvalidIds =
        (errors.invalid_external_user_ids?.length ?? 0) > 0 ||
        (errors.invalid_player_ids?.length ?? 0) > 0 ||
        (errors.invalid_aliases !== undefined &&
          Object.keys(errors.invalid_aliases).length > 0);
      if (hasInvalidIds) {
        isInvalidRecipient = true;
        firstMessage = JSON.stringify(errors);
      }
    }

    if (!isInvalidRecipient) return null;

    return new ConnectorError({
      message: firstMessage || 'OneSignal invalid recipient',
      statusCode: httpStatus,
      providerCode: 'invalid_recipient',
      providerMessage: firstMessage || 'OneSignal invalid recipient',
      cause: { raw },
    });
  }

  /**
   * HTTP-layer mapping. Parses `Retry-After`:
   * embeds parsed seconds in `providerMessage` text; raw header value is
   * attached to `cause.retryAfter`. No structured `retryAfterSeconds` field
   * Retry is consumer policy (no retryAfterSeconds field) — the wrapper performs no
   * retry.
   */
  private mapVendorError(
    status: number,
    body:
      | OneSignalSendResponse
      | { errors?: unknown; message?: string }
      | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const providerCode = mapOneSignalErrorToProviderCode(status, body);
    const baseProviderMessage = extractErrorMessage(body, status);

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    return new ConnectorError({
      message: baseProviderMessage,
      statusCode: status,
      providerCode,
      providerMessage: baseProviderMessage,
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

    const payload: Record<string, unknown> = {
      app_id: this.config.appId,
      contents: { en: overrides.body ?? options.content },
      headings: { en: overrides.title ?? options.title },
      include_subscription_ids: options.target,
      target_channel: 'push',
    };

    if (options.payload && Object.keys(options.payload).length > 0) {
      payload.data = options.payload;
    }

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(ONE_SIGNAL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // both surfaces use the same Authorization: Basic header.
          Authorization: `Basic ${this.config.apiKey}`,
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
        | OneSignalSendResponse
        | { errors?: unknown; message?: string }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as OneSignalSendResponse;
    if (!data.id) {
      const errors = data.errors;
      const message = Array.isArray(errors)
        ? errors.join('; ')
        : 'OneSignal push failed';
      throw new ConnectorError({
        message,
        statusCode: 400,
        providerCode: 'invalid_recipient',
        providerMessage: message,
        cause: { raw: data },
      });
    }

    return {
      id: data.id,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Map OneSignal HTTP status body to canonical `ProviderCode`
 * .
 *
 *   401 -> auth_failed
 *   400 -> invalid_request (request validation)
 *   404 -> invalid_request (app not found)
 *   429 -> rate_limited
 *   500 / 503 -> provider_unavailable
 *   200 with invalid-recipient error markers -> invalid_recipient (handled in
 *     `mapTicketError`, not here)
 *   other -> unknown
 */
function mapOneSignalErrorToProviderCode(
  status: number,
  _body:
    | OneSignalSendResponse
    | { errors?: unknown; message?: string }
    | null,
): ProviderCode {
  if (status === 401) return 'auth_failed';
  if (status === 400) return 'invalid_request';
  if (status === 404) return 'invalid_request';
  if (status === 429) return 'rate_limited';
  if (status === 500 || status === 503) return 'provider_unavailable';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

/**
 * Extract a human-readable error message from a OneSignal error body. Falls
 * through array-of-strings -> stringified errors object -> `body.message` ->
 * generic fallback.
 */
function extractErrorMessage(
  body:
    | OneSignalSendResponse
    | { errors?: unknown; message?: string }
    | null,
  status: number,
): string {
  if (body !== null && typeof body === 'object') {
    const errors = (body as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0 && typeof errors[0] === 'string') {
      return errors[0];
    }
    if (errors !== null && typeof errors === 'object' && !Array.isArray(errors)) {
      return JSON.stringify(errors);
    }
    const message = (body as { message?: string }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return `OneSignal ${status}`;
}
