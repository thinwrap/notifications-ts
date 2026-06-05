import type { EmailSendInput } from '../../types';

/**
 * Narrowed Mailtrap input — at v1.0 all Mailtrap-specific extras travel via
 * `_passthrough.body` (subject to the snake_case transform), so the
 * narrowed shape is structurally identical to the canonical `EmailSendInput`.
 *
 * Consumer-facing extras that flow through `_passthrough.body` and are
 * casing-transformed to snake_case on the wire:
 *   - `templateUuid`      → `template_uuid`
 *   - `templateVariables` → `template_variables`
 *   - `customVariables`   → `custom_variables`
 *   - `category`          → `category`
 *
 * Promotion of any of these to first-class narrowed fields is deferred to v1.1.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MailtrapEmailSendInput extends EmailSendInput {}

/**
 * Mailtrap 2xx response body.
 */
export interface MailtrapSendResponse {
  success: boolean;
  message_ids: string[];
  errors?: string[];
}

/**
 * Mailtrap 4xx/5xx error response body.
 */
export interface MailtrapErrorResponse {
  success: false;
  errors: string[];
}
