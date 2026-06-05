import type { EmailSendInput } from '../../types';

/**
 * MailerSend-specific narrowed input. MailerSend's templated-email surface
 * (`template_id` + per-recipient `personalization` / legacy `variables`) and
 * scheduled-send (`send_at`) are intentionally NOT promoted to the narrowed
 * type at v1.0 the >=90% baseline-coverage rule: the variables
 * payload shape is incoherent across vendors. These features remain accessible
 * via `_passthrough.body`; consumer-supplied camelCase keys (e.g., `templateId`,
 * `sendAt`, `inReplyTo`) are transformed to snake_case by the connector before
 * the wire body is built.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MailerSendEmailSendInput extends EmailSendInput {}

/**
 * MailerSend API error body shape. Validation errors are keyed by field
 * (dotted paths like `from.email`, `to.0.email`, `attachments.0.content`).
 *
 * See https://developers.mailersend.com/api/v1/email.html for the canonical
 * error response schema.
 */
export interface MailerSendErrorResponse {
  message: string;
  errors?: Record<string, string[]>;
}
