import type { EmailSendInput } from '../../types';

/**
 * Resend-specific narrowed input. Promoted fields here are first-class on
 * `.send()` for Resend; everything else flows through `_passthrough` per the
 * baseline-coverage discipline (≥90% rule — Resend-only fields aren't on the
 * normalized facade).
 */
export interface ResendEmailSendInput extends EmailSendInput {
  /**
   * RFC 3339 timestamp for Resend's "schedule send" feature; forwarded as
   * `scheduled_at` on the wire body.
   */
  scheduledAt?: string;
}

export interface ResendSendEmailResponse {
  id: string;
}

/**
 * Shape of Resend JSON error bodies per
 * https://resend.com/docs/api-reference/errors.
 */
export interface ResendErrorResponse {
  statusCode?: number;
  name?: string;
  message?: string;
}
