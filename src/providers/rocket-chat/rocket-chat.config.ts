// webhook-URL-as-auth: the Rocket.Chat Incoming Webhook URL itself is the
// credential; leak = posting authority on the destination channel.
//
// A webhook URL replaces the REST-API credential set (`serverUrl` + `authToken` +
// `userId` + `roomId`) that the unpublished predecessor used. Nothing ever shipped
// with those fields, so no migration shim is owed.
export interface RocketChatConfig {
  /** Rocket.Chat Incoming Webhook URL (Integrations → New → Incoming Webhook) — IS the credential. */
  webhookUrl: string;
  /** BYO fetch hook — the wrapper holds no state. */
  fetch?: typeof fetch;
}
