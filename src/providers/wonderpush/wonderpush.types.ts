import type { PushSendInput } from '../../types';

/**
 * WonderPush-specific augmentation of the universal `PushSendInput`. Each
 * field captures a documented WonderPush deliveries-API parameter that is
 * WonderPush-only and therefore below the 90% baseline-coverage threshold per
 * Per the >=90% baseline-coverage rule; anything else flows through
 * `_passthrough.body`.
 *
 * `data` is widened from the base `Record<string, string>` to
 * `Record<string, unknown>` — WonderPush accepts arbitrary JSON inside
 * `notification.custom`.
 */
export interface WonderPushInputAugmentation {
  /** Arbitrary JSON payload — lands in `notification.custom`. */
  data?: Record<string, unknown>;

  /** iOS-style subtitle line — lands in `notification.alert.subtitle`. */
  subtitle?: string;

  /** iOS badge count → `notification.badge`. Sub-baseline (not on `PushSendInput`). */
  badge?: number;

  /** Notification sound → `notification.sound`. Sub-baseline (not on `PushSendInput`). */
  sound?: string;

  // ---------------------------------------------------------------------------
  // Recipient routing
  // ---------------------------------------------------------------------------

  /**
   * Overrides the default `[input.to]` single-element wrapping. Useful when
   * the consumer has a known list of WonderPush user IDs.
   */
  targetUserIds?: string[];

  /** Broadcast to one or more named segments. May coexist with `targetUserIds`. */
  targetSegmentIds?: string[];

  /** Ad-hoc segmentation criteria forwarded verbatim. */
  customSegmentation?: Record<string, unknown>;

  // ---------------------------------------------------------------------------
  // Advanced notification structure override
  // ---------------------------------------------------------------------------

  /**
   * Full `notification` block override. When set, the consumer assumes
   * responsibility for the structure; the connector still merges the base
   * `title`/`body`/`sound`/`badge`/`data`/`subtitle` field-level defaults under it.
   */
  notification?: {
    alert?: { title?: string; text?: string; subtitle?: string };
    sound?: string;
    badge?: number;
    custom?: Record<string, unknown>;
    actions?: Array<Record<string, unknown>>;
    categories?: string[];
  };

  /** Top-level WonderPush `actions` (also accepted by the API at the root). */
  actions?: Array<Record<string, unknown>>;

  /** Top-level WonderPush `categories` (also accepted by the API at the root). */
  categories?: string[];
}

/**
 * Narrowed input for `WonderPushPushConnector.send()`. Inherits the universal
 * `PushSendInput` shape and widens `data` per `WonderPushInputAugmentation`.
 */
export interface WonderPushNarrowedInput
  extends Omit<PushSendInput, 'data'>,
    WonderPushInputAugmentation {}

/**
 * Legacy alias preserved for the brownfield surface and Novu
 * consumers. New code should use {@link WonderPushNarrowedInput}.
 */
export type WonderPushPushSendInput = WonderPushNarrowedInput;

export interface WonderPushSendResponse {
  success?: boolean;
  /** Some endpoints return `notificationId`; others return `id`. */
  notificationId?: string;
  id?: string;
}
