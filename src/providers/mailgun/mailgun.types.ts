import type { EmailSendInput } from '../../types';

/**
 * Mailgun-specific narrowed input. Mailgun-specific options are accessed via
 * `_passthrough.body` at v1.0 (e.g. `o:tag`, `o:deliverytime`, `o:tracking`,
 * `o:tracking-clicks`, `o:tracking-opens`, `v:<var-name>`, `template`,
 * `t:variables`). Promotion to first-class narrowed fields deferred to v1.1.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MailgunEmailSendInput extends EmailSendInput {}

/**
 * Successful Mailgun `POST /v3/<domain>/messages` response body.
 * `id` is the `<message-id>@<domain>` form.
 */
export interface MailgunSendResponse {
  id: string;
  message: string;
}

/**
 * Mailgun JSON error response body. Mailgun returns `{ message: '...' }`
 * with the failure reason as the sole field.
 */
export interface MailgunErrorResponse {
  message?: string;
}
