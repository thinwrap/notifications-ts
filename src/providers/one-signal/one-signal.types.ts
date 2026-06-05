import type { PushSendInput } from '../../types';

/**
 * OneSignal-specific augmentations of the universal `PushSendInput`. Each
 * field captures a documented OneSignal REST API v1 parameter that is
 * OneSignal-only and therefore below the 90% baseline-coverage threshold per
 * Per the >=90% baseline-coverage rule; consumers needing further
 * fields flow them through `_passthrough.body`.
 *
 * **Recipient routing precedence :** when any of the
 * augmentation recipient fields is set (`include_external_user_ids`,
 * `include_player_ids`, `included_segments`, `excluded_segments`), the base
 * `input.to` is ignored and `include_subscription_ids` is omitted from the
 * wire body.
 *
 * `data` is widened from the base `Record<string, string>` to
 * `Record<string, unknown>` — OneSignal accepts arbitrary JSON in `data`.
 */
export interface OneSignalInputAugmentation {
  /** Arbitrary JSON payload — OneSignal widens this beyond FCM's string-only shape. */
  data?: Record<string, unknown>;

  // ---------------------------------------------------------------------------
  // Recipient routing (when any is set, base `input.to` is ignored)
  // ---------------------------------------------------------------------------
  include_external_user_ids?: string[];
  /** Legacy field — still supported by OneSignal. */
  include_player_ids?: string[];
  included_segments?: string[];
  excluded_segments?: string[];

  // ---------------------------------------------------------------------------
  // Localized title/body (when set, override input.title / input.body)
  // ---------------------------------------------------------------------------
  /** Localized titles, e.g. `{ en: 'Hi', es: 'Hola' }`. */
  headings?: Record<string, string>;
  /** Localized bodies. */
  contents?: Record<string, string>;

  // ---------------------------------------------------------------------------
  // Platform-specific
  // ---------------------------------------------------------------------------
  ios_attachments?: Record<string, string>;
  /** Android — image URL. */
  big_picture?: string;
  android_channel_id?: string;
  ios_sound?: string;
  android_sound?: string;

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------
  /** ISO 8601 timestamp. */
  send_after?: string;
  delayed_option?: 'timezone' | 'last-active';

  // ---------------------------------------------------------------------------
  // Other
  // ---------------------------------------------------------------------------
  /** OneSignal-specific priority scale (1-10). */
  priority?: number;
  /** Idempotency key. */
  external_id?: string;
  collapse_id?: string;
  /** Seconds the message stays deliverable (`ttl` body field). Sub-baseline (not on `PushSendInput`). */
  ttl?: number;
}

/**
 * OneSignal-narrowed `PushSendInput`. Consumers calling `.send()` against the
 * OneSignal connector populate any augmentation alongside the universal
 * `PushSendInput` fields.
 */
export interface OneSignalNarrowedInput
  extends Omit<PushSendInput, 'data'>,
    OneSignalInputAugmentation {}

/**
 * Legacy alias preserved for the brownfield surface and Novu
 * consumers. New code should use {@link OneSignalNarrowedInput}.
 */
export type OneSignalPushSendInput = OneSignalNarrowedInput;

/**
 * OneSignal REST API v1 response body shape from
 * `POST /api/v1/notifications`., OneSignal returns HTTP 200 even
 * when all recipients are invalid; the `errors` field carries the failure
 * detail (either a string array or an object with invalid-id maps).
 */
export interface OneSignalSendResponse {
  id: string;
  recipients?: number;
  external_id?: string | null;
  errors?:
    | string[]
    | {
        invalid_external_user_ids?: string[];
        invalid_aliases?: Record<string, unknown>;
        invalid_player_ids?: string[];
      };
}
