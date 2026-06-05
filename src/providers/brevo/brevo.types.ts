import type { EmailSendInput } from '../../types';

/**
 * Narrowed input for the Brevo connector. Brevo-specific extras flow through
 * `_passthrough.body` at v1.0 (e.g., `templateId`, `params`, `messageVersions`,
 * `scheduledAt`, `batchId`). Promotion to first-class narrowed fields is
 * deferred to the v1.1 templated-email epic.
 *
 * NOTE: If `attachments[].contentId` is set, `BrevoEmailConnector.send()`
 * throws a pre-flight `ConnectorError({ providerCode: 'invalid_request' })`
 * BEFORE any HTTP call — Brevo's `/v3/smtp/email` has no first-class cid mechanism.
 */
export interface BrevoEmailSendInput extends EmailSendInput {
  /** Brevo template id (forwarded as `templateId`). */
  templateId?: number;
  /** Brevo template params / merge variables (forwarded as `params`). */
  params?: Record<string, unknown>;
  /** Per-recipient personalization batch (forwarded as `messageVersions`). */
  messageVersions?: Array<Record<string, unknown>>;
  /** ISO 8601 schedule timestamp (forwarded as `scheduledAt`). */
  scheduledAt?: string;
  /** Idempotent batch id (forwarded as `batchId`). */
  batchId?: string;
}

/** Brevo success response shape for POST `/v3/smtp/email`. */
export interface BrevoSendResponse {
  messageId: string;
}

/** Brevo error response shape (4xx/5xx). */
export interface BrevoErrorResponse {
  code: string;
  message: string;
}
