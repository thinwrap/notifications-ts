// webhook-URL-as-auth: the URL itself is the credential; leak = posting authority on the destination Mattermost channel.
export interface MattermostConfig {
  /** Mattermost Incoming Webhook URL — IS the credential. */
  webhookUrl?: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
