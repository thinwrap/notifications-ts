// webhook-URL-as-auth: the URL itself is the credential. The Google
// Chat incoming-webhook URL embeds `?key=<key>&token=<token>` query parameters
// — those are part of the credential surface and forwarded verbatim. Leak =
// posting authority on the destination space.
export interface GoogleChatConfig {
  /** Google Chat incoming-webhook URL — IS the credential. */
  webhookUrl?: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
