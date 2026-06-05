import type { PushSendInput } from '../../types';

/**
 * APNs-specific narrowed augmentations of the universal `PushSendInput`.
 * APNs widens `data` to `Record<string, unknown>` — custom payload keys can
 * carry any JSON value (per Apple's docs, root-level custom keys may be
 * arbitrary JSON).
 *
 * The `aps` block spells Apple's kebab-case keys verbatim (e.g.
 * `'thread-id'`, `'content-available'`). No casing transform is applied;
 * consumers populate the wire-spec keys directly.
 */
export interface ApnsInputAugmentation {
  /** APNs widens `data` from the base `Record<string, string>` to allow arbitrary JSON. */
  data?: Record<string, unknown>;

  /** iOS badge count → `aps.badge`. Sub-baseline (not on `PushSendInput`). */
  badge?: number;

  /** Notification sound → `aps.sound`. Sub-baseline (not on `PushSendInput`). */
  sound?: string;

  /** Seconds until expiry → `apns-expiration` header. Sub-baseline (not on `PushSendInput`). */
  ttl?: number;

  /** Apple-spec `aps` dictionary. Kebab-case keys per Apple's wire format. */
  aps?: {
    alert?: { title?: string; body?: string; subtitle?: string };
    sound?: string | { critical?: boolean; name?: string; volume?: number };
    badge?: number;
    'thread-id'?: string;
    category?: string;
    'content-available'?: 0 | 1;
    'mutable-content'?: 0 | 1;
    'interruption-level'?: 'passive' | 'active' | 'time-sensitive' | 'critical';
    'relevance-score'?: number;
  };

  /** Overrides `config.bundleId` in the `apns-topic` header on a per-send basis. */
  apnsTopic?: string;

  /** Defaults to `'alert'` when `title`/`body` present, else `'background'`. */
  apnsPushType?:
    | 'alert'
    | 'background'
    | 'voip'
    | 'complication'
    | 'fileprovider'
    | 'mdm'
    | 'liveactivity'
    | 'pushtotalk';

  /** 10 = immediate; 5 = considerate. */
  apnsPriority?: 5 | 10;

  apnsCollapseId?: string;

  /** Explicit unix-timestamp override for `apns-expiration`. Otherwise computed from `input.ttl`. */
  apnsExpiration?: number;
}

/**
 * APNs-narrowed `PushSendInput`. Consumers calling `.send()` against the
 * APNs connector can populate any of the APNs augmentations alongside the
 * universal `PushSendInput` fields.
 */
export type ApnsPushSendInput = Omit<PushSendInput, 'data'> & ApnsInputAugmentation;

// ---------------------------------------------------------------------------
// APNs wire shapes
// ---------------------------------------------------------------------------

/**
 * The APNs JSON request body. The `aps` dictionary plus arbitrary custom
 * data keys merged at the root level (Apple's spec).
 */
export interface ApnsPayload {
  aps: {
    alert?: { title?: string; body?: string; subtitle?: string };
    badge?: number;
    sound?: string | { critical?: boolean; name?: string; volume?: number };
    'thread-id'?: string;
    category?: string;
    'mutable-content'?: 0 | 1;
    'content-available'?: 0 | 1;
    'interruption-level'?: 'passive' | 'active' | 'time-sensitive' | 'critical';
    'relevance-score'?: number;
  };
  [key: string]: unknown;
}

export interface ApnsErrorResponse {
  reason?: string;
  timestamp?: number;
}
