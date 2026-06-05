import type { EmailSendInput } from '../../types';

/**
 * SendGrid-specific narrowed input. SendGrid's templated-email API
 * (`template_id` + `personalizations[].dynamic_template_data`) is intentionally
 * NOT promoted to the narrowed type at v1.0 the >=90% baseline-coverage rule:
 * coverage is ≥90% across providers but the variables payload shape is
 * incoherent across vendors. Templates remain accessible via `_passthrough.body`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SendgridEmailSendInput extends EmailSendInput {}

/**
 * SendGrid v3 `mail/send` JSON error body shape. See
 * https://docs.sendgrid.com/api-reference/mail-send/mail-send for the canonical
 * schema; `field` is dotted (e.g., `personalizations.0.to.0.email`).
 */
export interface SendgridErrorResponse {
  errors: Array<{
    message: string;
    field?: string;
    help?: string;
  }>;
}

export interface SendgridPersonalization {
  to: { email: string; name?: string }[];
  cc?: { email: string; name?: string }[];
  bcc?: { email: string; name?: string }[];
  subject?: string;
  dynamic_template_data?: Record<string, unknown>;
}

export interface SendgridAttachment {
  content: string;
  filename: string;
  type?: string;
  disposition?: string;
  content_id?: string;
}

export interface SendgridSendRequestBody {
  personalizations: SendgridPersonalization[];
  from: { email: string; name?: string };
  subject: string;
  content: { type: string; value: string }[];
  reply_to?: { email: string; name?: string };
  attachments?: SendgridAttachment[];
  headers?: Record<string, string>;
  categories?: string[];
  template_id?: string;
}
