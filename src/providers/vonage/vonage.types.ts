import type { SmsSendInput } from '../../types';

/**
 * Vonage-narrowed extension of `SmsSendInput`. All Vonage-specific fields are
 * optional; baseline `SmsSendInput` (`from?`, `to`, `body`, `_passthrough?`)
 * is preserved verbatim. the >=90% baseline-coverage rule, these
 * fields are below the ≥90% baseline so they do not surface on the universal
 * `SmsSendInput`.
 */
export interface VonageNarrowedInput extends SmsSendInput {
  /** Up to 40 chars — Vonage `client-ref`. */
  clientRef?: string;
  /** SMS Message Class (0 = flash, displayed on lock screen, not stored). */
  messageClass?: 0 | 1 | 2 | 3;
  /** Payload type. */
  type?: 'text' | 'binary' | 'wappush' | 'unicode';
  /** Request DLR (delivery receipt webhook). */
  statusReportReq?: 0 | 1;
  /** Time-to-live in milliseconds (Vonage default 259200000 = 72h). */
  ttl?: number;
  /** DLR callback URL override. */
  callback?: string;
}

/**
 * Vonage's `POST /sms/json` 2xx response envelope. Vonage emits HTTP 200 even
 * for soft errors — per-message `status` is the source of truth.
 *
 * Wire keys are kebab-case; bracket-quoted property names preserve them on
 * the TS shape.
 */
export interface VonageSmsResponse {
  'message-count': string;
  messages: Array<{
    status: string;
    'message-id'?: string;
    to?: string;
    'error-text'?: string;
    'client-ref'?: string;
    'remaining-balance'?: string;
    'message-price'?: string;
    network?: string;
  }>;
}
