import type { PushSendInput } from '../../types';

/**
 * FCM-specific narrowed augmentations of the universal `PushSendInput`. The
 * baseline `PushSendInput.data` is `Record<string, string>` already; FCM
 * confirms that constraint (FCM serializes all `data` values as strings on
 * the wire — non-string values must be JSON-stringified by the consumer).
 *
 * Platform-specific blocks (`android`, `apns`, `webpush`, `fcm_options`) are
 * minimally-typed so consumers can populate documented FCM HTTP v1 fields
 * directly; rarely-used fields flow through `_passthrough.body.message.*`
 * per the baseline-coverage discipline (≥90% rule).
 *
 * Note: `apns` here is the **FCM-side APNs payload nested inside an FCM
 * message** — it is NOT a reference to `ApnsPushConnector`.
 */
export interface FcmInputAugmentation {
  /** FCM wire constraint: all `data` values are strings. */
  data?: Record<string, string>;
  /** Seconds the message stays deliverable — folds into `android.ttl` as `"<n>s"`. Sub-baseline (not on `PushSendInput`). */
  ttl?: number;
  android?: AndroidConfig;
  apns?: ApnsBlock;
  webpush?: WebpushConfig;
  fcm_options?: FcmOptionsConfig;
}

export interface AndroidConfig {
  /** "<seconds>s" per FCM HTTP v1 spec. */
  ttl?: string;
  priority?: 'NORMAL' | 'HIGH';
  collapse_key?: string;
  restricted_package_name?: string;
  notification?: Record<string, unknown>;
  data?: Record<string, string>;
  fcm_options?: { analytics_label?: string };
  direct_boot_ok?: boolean;
}

export interface ApnsBlock {
  headers?: Record<string, string>;
  payload?: { aps?: Record<string, unknown>; [k: string]: unknown };
  fcm_options?: { analytics_label?: string; image?: string };
}

export interface WebpushConfig {
  headers?: Record<string, string>;
  data?: Record<string, string>;
  notification?: Record<string, unknown>;
  fcm_options?: { analytics_label?: string; link?: string };
}

export interface FcmOptionsConfig {
  analytics_label?: string;
}

/**
 * FCM-narrowed `PushSendInput`. Consumers calling `.send()` against the FCM
 * connector can populate any of the FCM augmentations alongside the
 * universal `PushSendInput` fields.
 */
export type FcmPushSendInput = PushSendInput & FcmInputAugmentation;

// ---------------------------------------------------------------------------
// FCM HTTP v1 wire shapes
// ---------------------------------------------------------------------------

export interface FcmMessage {
  token?: string;
  topic?: string;
  condition?: string;
  notification?: {
    title?: string;
    body?: string;
    image?: string;
  };
  data?: Record<string, string>;
  android?: Record<string, unknown>;
  apns?: Record<string, unknown>;
  webpush?: Record<string, unknown>;
  fcm_options?: Record<string, unknown>;
  fcmOptions?: Record<string, unknown>;
}

export interface FcmSendRequest {
  message: FcmMessage;
}

export interface FcmSendResponse {
  name: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Shape of FCM HTTP v1 JSON error bodies. Per the FCM spec, `error.status`
 * is the canonical machine-readable code (`UNAUTHENTICATED`, `INVALID_ARGUMENT`,
 * `NOT_FOUND`, `SENDER_ID_MISMATCH`, `QUOTA_EXCEEDED`, `UNAVAILABLE`,
 * `INTERNAL`, etc.). `error.message` is human-readable.
 */
export interface FcmErrorResponse {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<Record<string, unknown>>;
  };
}
