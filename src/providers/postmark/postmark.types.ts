import type { EmailSendInput } from '../../types';

/**
 * Narrowed input for the Postmark connector. Postmark-specific extras flow
 * through `_passthrough.body` at v1.0 (e.g., `MessageStream` per-send override,
 * `TemplateId` / `TemplateAlias` / `TemplateModel`, `Metadata`, `TrackOpens`,
 * `TrackLinks`). Promotion to first-class narrowed fields is deferred to the
 * v1.1 templated-email epic.
 */
export interface PostmarkEmailSendInput extends EmailSendInput {
  /** Postmark template id (forwarded as `TemplateId`). */
  templateId?: number;
  /** Postmark template alias (forwarded as `TemplateAlias`). */
  templateAlias?: string;
  /** Postmark template model (forwarded as `TemplateModel`). */
  templateModel?: Record<string, unknown>;
  /** Per-send override of `config.messageStream` (forwarded as `MessageStream`). */
  messageStream?: string;
  /** Track opens flag (forwarded as `TrackOpens`). */
  trackOpens?: boolean;
  /** Track links setting (forwarded as `TrackLinks`). */
  trackLinks?: string;
}

/** Postmark success response shape for POST `/email`. */
export interface PostmarkSendEmailResponse {
  To: string;
  SubmittedAt: string;
  MessageID: string;
  ErrorCode: number;
  Message: string;
}

/** Postmark error response shape (both 4xx/5xx responses and embedded errors in 200 bodies). */
export interface PostmarkErrorResponse {
  ErrorCode: number;
  Message: string;
}
