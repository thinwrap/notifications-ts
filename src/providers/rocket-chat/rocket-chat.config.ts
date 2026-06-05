// webhook-URL-as-auth: the Rocket.Chat Incoming Webhook URL itself is the
// credential; leak = posting authority on the destination channel.
//
// Breaking config change vs brownfield (which used REST-API auth with
// `serverUrl` + `authToken` + `userId` + `roomId`). this is the first public release with no prior consumers
// the predecessor was never published, so no migration shim is owed.
export interface RocketChatConfig {
  /** Rocket.Chat Incoming Webhook URL (Integrations → New → Incoming Webhook) — IS the credential. */
  webhookUrl: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
