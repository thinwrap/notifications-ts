import type { PushSendInput } from '../../types';

/**
 * Expo-specific augmentations of the universal `PushSendInput`. Each field
 * captures a documented Expo push-API parameter that is Expo-only and
 * therefore below the 90% baseline-coverage threshold per
 * Per the >=90% baseline-coverage rule; consumers needing further fields
 * flow them through `_passthrough.body`.
 *
 * `data` matches the base `Record<string, string>` shape — although Expo
 * accepts arbitrary JSON, we constrain to strings for cross-provider
 * consistency. Consumers needing richer `data` shapes route
 * `_passthrough.body.data`.
 */
export interface ExpoInputAugmentation {
  /** String-keyed/string-valued payload — matches FCM's data shape. */
  data?: Record<string, string>;
  /** iOS badge count. Sub-baseline (not on `PushSendInput`); Expo supports it natively. */
  badge?: number;
  /** Notification sound, e.g. `'default'`. Sub-baseline; Expo supports it natively. */
  sound?: string;
  /** Seconds the message stays deliverable. Sub-baseline; Expo supports it natively. */
  ttl?: number;
  /** When true, the notification displays even while the foreground app is open. */
  _displayInForeground?: boolean;
  /** iOS notification category for action buttons. */
  categoryId?: string;
  /** Android notification channel ID. */
  channelId?: string;
  /** iOS — allows a notification-service-extension to modify the payload. */
  mutableContent?: boolean;
  /** Expo delivery-priority hint (mapped to APNs/FCM priority internally). */
  priority?: 'default' | 'normal' | 'high';
  /** iOS-only subtitle line, shown below the title. */
  subtitle?: string;
  /** iOS 15+ interruption-level (drives Focus / Do-Not-Disturb behavior). */
  interruptionLevel?: 'active' | 'critical' | 'passive' | 'time-sensitive';
}

/**
 * Narrowed input for `ExpoPushConnector.send()`. Inherits the universal
 * `PushSendInput` shape and widens `data` per `ExpoInputAugmentation`.
 */
export interface ExpoNarrowedInput
  extends Omit<PushSendInput, 'data'>,
    ExpoInputAugmentation {}

/**
 * Legacy alias preserved for the brownfield surface and Novu
 * consumers. New code should use {@link ExpoNarrowedInput}.
 */
export type ExpoPushSendInput = ExpoNarrowedInput;

export interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface ExpoSendResponse {
  data: ExpoTicket[] | ExpoTicket;
}
