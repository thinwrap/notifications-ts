export interface MailerSendConfig {
  /** MailerSend API token, sent as `Authorization: Bearer <apiToken>`. */
  apiToken: string;
  /** Default sender email address. */
  from: string;
  /** Optional default sender display name. */
  senderName?: string;
  /** Optional BYO fetch implementation. */
  fetch?: typeof fetch;
}
