import type { EmailSendInput } from '../../types';

/**
 * SES-specific narrowed input. Promoted fields here are first-class on `.send()`
 * for SES; everything else flows through `_passthrough` per the baseline-coverage
 * discipline (≥90% rule — SES-specific bits aren't on the normalized facade).
 */
export interface SesEmailSendInput extends Omit<EmailSendInput, 'tags'> {
  /** Per-send override for SES configuration set (forwarded as `ConfigurationSetName`). */
  configurationSetName?: string;
  /** SES `FromEmailAddressIdentityArn` — for cross-account sending identity. */
  sourceArn?: string;
  /**
   * SES v2 `FeedbackForwardingEmailAddress`: "The address that you want bounce
   * and complaint notifications to be sent to".
   */
  feedbackForwardingEmailAddress?: string;
  /**
   * @deprecated SES v2 has no `ReturnPath`; this is sent as
   * `FeedbackForwardingEmailAddress`. Use `feedbackForwardingEmailAddress`.
   */
  returnPath?: string;
  /**
   * SES `EmailTags` for per-message tagging (analytics, CloudWatch).
   * Overrides the base `EmailSendInput.tags: string[]` with the SES-shaped
   * `{ Name, Value }[]` so consumers picking the SES narrowed input get the
   * canonical SES wire shape directly.
   */
  tags?: Array<{ Name: string; Value: string }>;
}

export interface SesV2SendEmailRequest {
  FromEmailAddress: string;
  FromEmailAddressIdentityArn?: string;
  Destination: {
    ToAddresses: string[];
    CcAddresses?: string[];
    BccAddresses?: string[];
  };
  ReplyToAddresses?: string[];
  FeedbackForwardingEmailAddress?: string;
  Content:
    | {
        Simple: {
          Subject: { Data: string; Charset?: string };
          Body: {
            Html?: { Data: string; Charset?: string };
            Text?: { Data: string; Charset?: string };
          };
          // SES v2 Message.Headers — custom email headers (max 15).
          Headers?: Array<{ Name: string; Value: string }>;
          // SES v2 Message.Attachments (botocore 1.37.27, 2025-04-03).
          // RawContent is base64 over the HTTPS interface.
          Attachments?: Array<{
            FileName: string;
            RawContent: string;
            ContentType?: string;
            ContentDisposition?: 'ATTACHMENT' | 'INLINE';
            ContentId?: string;
            ContentDescription?: string;
            ContentTransferEncoding?: 'BASE64' | 'QUOTED_PRINTABLE' | 'SEVEN_BIT';
          }>;
        };
      }
    | {
        Raw: {
          Data: string; // base64-encoded MIME
        };
      };
  EmailTags?: Array<{ Name: string; Value: string }>;
  ConfigurationSetName?: string;
}

export interface SesV2SendEmailResponse {
  MessageId: string;
}

/**
 * Shape of SES v2 JSON error bodies. Field casing is inconsistent across SES
 * error paths (some 4xx use `__type` + `message`, others `type` + `Message`,
 * legacy XML-translated ones use `Code`). The error mapper reads all variants.
 */
export interface SesV2ErrorResponse {
  code?: string;
  message?: string;
  Message?: string;
  type?: string;
  __type?: string;
  Code?: string;
}
