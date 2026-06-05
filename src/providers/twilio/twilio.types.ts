import type { SmsSendInput } from '../../types';

export type TwilioRegion = 'us1' | 'us2' | 'ie1' | 'au1' | 'br1' | 'de1' | 'jp1' | 'sg1';

/**
 * Twilio-specific augmentations of the universal `SmsSendInput`. Each field
 * captures a documented `messages.create()` parameter that is Twilio-only and
 * therefore below the 90% baseline-coverage threshold per
 * Per the >=90% baseline-coverage rule; consumers needing further fields
 * (e.g., a new Twilio parameter shipped next quarter) flow them through
 * `_passthrough.body`.
 */
export interface TwilioNarrowedInput extends SmsSendInput {
  /** Alternative to `from` — Twilio Messaging Service SID (pool of senders). */
  messagingServiceSid?: string;
  /** MMS attachments — each URL is sent as a separate `MediaUrl` form field. */
  mediaUrl?: string[];
  /** Delivery-status webhook URL. */
  statusCallback?: string;
  /** TwiML application SID. */
  applicationSid?: string;
  /** Cap per-message price in account currency, as a decimal string. */
  maxPrice?: string;
  /** Twilio Confirmed Delivery feature. */
  provideFeedback?: boolean;
  /** 1-14400 seconds. */
  validityPeriod?: number;
  forceDelivery?: boolean;
  contentRetention?: 'retain' | 'discard';
  addressRetention?: 'retain' | 'obfuscate';
  smartEncoded?: boolean;
  /** e.g., `['geo:37.7749,-122.4194']`. */
  persistentAction?: string[];
  shortenUrls?: boolean;
  scheduleType?: 'fixed';
  /** ISO 8601, required when `scheduleType === 'fixed'`. */
  sendAt?: string;
  sendAsMms?: boolean;
  /** JSON-stringified variables for Content API templates. */
  contentVariables?: string;
  riskCheck?: 'enable' | 'disable';
  /** Twilio Content API template SID. */
  contentSid?: string;
}

/**
 * Brownfield narrowed input (pre, post). Preserved as a
 * type alias so the existing `sendMessage()` surface and consumers
 * keep compiling; new code should use {@link TwilioNarrowedInput}.
 */
export interface TwilioSmsSendInput extends Omit<SmsSendInput, 'from'> {
  from: string;
}

/**
 * Twilio Messages API response. Documented shape from
 * https://www.twilio.com/docs/sms/api/message-resource — fields are sent in
 * snake_case on the wire.
 */
export interface TwilioMessageResponse {
  sid: string;
  account_sid?: string;
  body?: string;
  date_created?: string;
  date_sent?: string | null;
  date_updated?: string;
  direction?: string;
  error_code?: number | null;
  error_message?: string | null;
  from?: string | null;
  messaging_service_sid?: string | null;
  num_media?: string;
  num_segments?: string;
  price?: string | null;
  price_unit?: string | null;
  status?: string;
  subresource_uris?: Record<string, string>;
  to?: string;
  uri?: string;
}

/**
 * Documented shape of a Twilio error response body. Twilio always returns
 * `{ code, message, more_info, status }` on 4xx/5xx.
 */
export interface TwilioErrorResponse {
  code?: number;
  message?: string;
  more_info?: string;
  status?: number;
}
