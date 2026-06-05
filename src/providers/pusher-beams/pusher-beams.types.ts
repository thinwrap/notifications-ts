import type { PushSendInput } from '../../types';

/**
 * Pusher Beams-specific augmentations of the universal `PushSendInput`.
 *
 * Beams is the canonical TS example of architecture decision 4.3
 * (the "outlier wire-translation" pattern): the publisher must supply BOTH
 * an FCM-formatted payload AND an APNs-formatted payload in the same
 * request (and optionally a Web push payload). Beams' server fans these
 * out to subscribed devices based on each device's registered token type.
 *
 * The connector synthesizes the nested `fcm`/`apns`/`web` payloads from
 * the base `PushSendInput` fields, then merges in the augmentation fields
 * below via shallow spread (augmentation wins on key collisions).
 *
 * The `data` field is widened from the base `Record<string, string>` to
 * `Record<string, unknown>`: FCM requires string values (the connector
 * coerces non-strings via JSON.stringify), but APNs and Web preserve the
 * original types.
 */
export interface PusherBeamsInputAugmentation {
  /** Widened from base; FCM portion gets string-coerced at synthesis time. */
  data?: Record<string, unknown>;

  /** iOS badge count → synthesized `apns.aps.badge`. Sub-baseline (not on `PushSendInput`). */
  badge?: number;

  /** Notification sound → synthesized `apns.aps.sound`. Sub-baseline (not on `PushSendInput`). */
  sound?: string;

  /** Seconds until expiry → `fcm.android.ttl` + `apns['apns-expiration']`. Sub-baseline (not on `PushSendInput`). */
  ttl?: number;

  // ---------------------------------------------------------------------
  // Alternative recipient routing
  // ---------------------------------------------------------------------

  /** Multi-user broadcast — overrides `input.to`. Uses `/publishes/users`. */
  users?: string[];
  /** Interest-broadcast — switches endpoint to `/publishes/interests`. */
  interests?: string[];

  // ---------------------------------------------------------------------
  // Platform payload overrides (merged into synthesized payloads)
  // ---------------------------------------------------------------------

  fcm?: {
    notification?: { title?: string; body?: string; icon?: string; tag?: string };
    data?: Record<string, string>;
    android?: {
      ttl?: string; // "<seconds>s"
      priority?: 'NORMAL' | 'HIGH';
      collapse_key?: string;
    };
  };
  apns?: {
    aps?: {
      alert?: { title?: string; body?: string; subtitle?: string };
      sound?: string;
      badge?: number;
      'thread-id'?: string;
      category?: string;
      'content-available'?: 0 | 1;
      'mutable-content'?: 0 | 1;
    };
    'apns-expiration'?: number;
    'apns-priority'?: 5 | 10;
    'apns-collapse-id'?: string;
  };
  web?: {
    notification?: { title?: string; body?: string; icon?: string; deep_link?: string };
    data?: Record<string, unknown>;
  };
}

/**
 * Narrowed input for `PusherBeamsPushConnector.send()`. Inherits the
 * universal `PushSendInput` shape (with `data` widened per the augmentation)
 * and adds Beams-specific routing + platform-override fields.
 */
export interface PusherBeamsPushSendInput
  extends Omit<PushSendInput, 'data'>,
    PusherBeamsInputAugmentation {}

/**
 * Pusher Beams publish-API success response shape.
 */
export interface PusherBeamsSendResponse {
  publishId: string;
}

/**
 * Pusher Beams publish-API error response shape.
 */
export interface PusherBeamsErrorResponse {
  error?: string;
  description?: string;
}
