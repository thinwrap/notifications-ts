/**
 * D7 Networks SMS connector config. D7's Messaging API uses Bearer-token auth
 * against the global endpoint `https://api.d7networks.com/messages/v1/send`.
 * No regional clustering — single host for all customers.
 */
export interface D7NetworksConfig {
  /** D7 API Token (Bearer). */
  apiToken: string;
  /** Default originator (alphanumeric or E.164). Per-call overridable via narrowed input. */
  from?: string;
  /** BYO `fetch` the wrapper holds no state. */
  fetch?: typeof fetch;
}
