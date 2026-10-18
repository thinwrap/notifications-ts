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
 * `notification.push.custom`.
 */
export interface WonderPushInputAugmentation {
  /** Arbitrary JSON payload — lands in `notification.push.custom`. */
  data?: Record<string, unknown>;

  /** iOS subtitle line — lands in `notification.alert.ios.subtitle`. */
  subtitle?: string;

  /** iOS badge count → `notification.alert.ios.badge`. Sub-baseline (not on `PushSendInput`). */
  badge?: number;

  /**
   * Notification sound → both `notification.alert.ios.sound` and
   * `notification.alert.android.sound`. Sub-baseline (not on `PushSendInput`).
   */
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
   * Full `notification` block override, in WonderPush's notification shape.
   * Deep-merged over the `title`/`body`/`sound`/`badge`/`data`/`subtitle`
   * field-level defaults: its leaves win, its other keys are kept alongside.
   */
  notification?: {
    alert?: {
      title?: string;
      text?: string;
      ios?: { sound?: string; badge?: number; subtitle?: string; [key: string]: unknown };
      android?: { sound?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    push?: { custom?: Record<string, unknown>; [key: string]: unknown };
    actions?: Array<Record<string, unknown>>;
    categories?: string[];
    [key: string]: unknown;
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
 * Alias kept for the Novu-compatible `sendMessage()` surface. New code should use
 * {@link WonderPushNarrowedInput}.
 */
export type WonderPushPushSendInput = WonderPushNarrowedInput;

export interface WonderPushSendResponse {
  success?: boolean;
  /** Some endpoints return `notificationId`; others return `id`. */
  notificationId?: string;
  id?: string;
}
