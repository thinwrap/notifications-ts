import type { EmailSendInput } from '../../types';

/**
 * SparkPost narrowed input. SparkPost-specific extras (`campaignId`, `metadata`,
 * `substitutionData`, `options.{startTime,transactional,sandbox,...}`,
 * `templateId`, `returnPath`, etc.) are surfaced via `_passthrough.body` at
 * v1.0 — promotion to top-level fields is deferred to v1.1.
 *
 * the connector calls `transformKeys(_passthrough.body,
 * CasingEnum.SNAKE_CASE)` before merging, so consumers may write
 * `{ campaignId: 'c1', substitutionData: { firstName: 'a' } }` and get
 * `campaign_id` / `substitution_data` in the wire body.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SparkPostEmailSendInput extends EmailSendInput {}

/**
 * SparkPost recipient envelope. Primary `to` recipients omit `header_to`; each
 * cc/bcc recipient is appended as a separate entry with
 * `address.header_to: <primary to>` per the canonical transform.
 */
export interface SparkPostRecipient {
  address: {
    email: string;
    name?: string;
    header_to?: string;
  };
}

/** 2xx response envelope from POST /api/v1/transmissions. */
export interface SparkPostSendResponse {
  results: {
    total_rejected_recipients: number;
    total_accepted_recipients: number;
    id: string;
  };
}

/** SparkPost error response envelope. */
export interface SparkPostErrorResponse {
  errors: Array<{
    message: string;
    code?: string;
    description?: string;
  }>;
}
