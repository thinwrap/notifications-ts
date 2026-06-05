import type { SmsSendInput } from '../../types';

/**
 * Sinch SMS API regional cluster. The base URL is `https://<region>.sms.api.sinch.com`;
 * only two regions are exposed today (`us` is the canonical default, `eu` provides
 * data residency). No map is necessary — the value is used as a subdomain prefix.
 */
export type SinchRegion = 'us' | 'eu';

/**
 * Sinch-narrowed extension of `SmsSendInput`. All Sinch-specific fields are
 * optional; baseline `SmsSendInput` (`from?`, `to`, `body`, `_passthrough?`)
 * is preserved verbatim. the >=90% baseline-coverage rule, these
 * fields are below the ≥90% baseline so they do not surface on the universal
 * `SmsSendInput`.
 */
export interface SinchNarrowedInput extends SmsSendInput {
  /** Default `mt_text`. `mt_binary` for binary SMS. */
  type?: 'mt_text' | 'mt_binary';
  /** Template-style parameter substitution. Per-recipient values are keyed by `to`. */
  parameters?: Record<string, Record<string, string> | string>;
  /** Delivery-report opt-in. */
  deliveryReport?: 'none' | 'summary' | 'full' | 'per_recipient';
  /** ISO 8601 — schedule send. */
  sendAt?: string;
  /** ISO 8601 — message expiry. */
  expireAt?: string;
  /** Override account-level callback URL. */
  callbackUrl?: string;
  /** Up to 128 chars. */
  clientReference?: string;
  /** Enable feedback. */
  feedbackEnabled?: boolean;
  /** Class 0 SMS — displayed on screen, not stored. */
  flashMessage?: boolean;
}

/**
 * Sinch `POST /xms/v1/<servicePlanId>/batches` 2xx response shape. Snake-case
 * wire keys preserved verbatim — this is the raw vendor envelope returned on
 * `SmsSendResult.raw`.
 */
export interface SinchSendResponse {
  id: string;
  to: string[];
  from: string;
  canceled?: boolean;
  body: string;
  type: string;
  created_at: string;
  modified_at: string;
  delivery_report?: string;
  expire_at?: string;
  flash_message?: boolean;
  client_reference?: string;
  feedback_enabled?: boolean;
}
