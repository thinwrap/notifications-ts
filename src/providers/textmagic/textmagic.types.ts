import type { SmsSendInput } from '../../types';

/**
 * Textmagic-narrowed extension of `SmsSendInput`. All Textmagic-specific fields
 * are optional; baseline `SmsSendInput` (`from?`, `to`, `body`, `_passthrough?`)
 * is preserved verbatim. the >=90% baseline-coverage rule, these
 * fields are below the ≥90% baseline so they do not surface on the universal
 * `SmsSendInput`.
 */
export interface TextmagicNarrowedInput extends SmsSendInput {
  /** Server-side template id. */
  templateId?: number;
  /** Unix timestamp (seconds) — schedule send. */
  sendingTime?: number;
  /** Timezone identifier (e.g. 'America/New_York') paired with `sendingTime`. */
  tz?: string;
  /** Limit SMS segments. */
  partsCount?: number;
  /** Numeric reference for this message. */
  referenceId?: number;
  /** RFC 5545 recurrence rule. */
  rrule?: string;
  /** Truncate to first segment. */
  cutExtra?: boolean;
}

/**
 * Textmagic `POST /api/v2/messages` 2xx response shape. Some endpoints return
 * `messageId` instead of `id`; both fields are checked for `providerMessageId`.
 * Full response is preserved verbatim on `SmsSendResult.raw`.
 */
export interface TextmagicSendResponse {
  id?: number;
  href?: string;
  type?: string;
  sessionId?: number;
  messageId?: number;
}
