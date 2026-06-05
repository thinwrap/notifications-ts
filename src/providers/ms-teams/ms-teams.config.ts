// webhook-URL-as-auth: the URL itself is the credential; leak = posting authority on the destination channel.
export interface MsTeamsConfig {
  /** MS Teams Incoming Webhook URL — IS the credential. */
  webhookUrl?: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
