export interface PostmarkConfig {
  /** Postmark server token (sent in `X-Postmark-Server-Token` header). */
  serverToken: string;
  /** Default sender email address. */
  from: string;
  /** Optional display name composed alongside `from` as `Name <addr>`. */
  senderName?: string;
  /**
   * Optional message stream id (e.g. 'outbound' for transactional, 'broadcasts'
   * for marketing). Applied to every send unless overridden via
   * `_passthrough.body.MessageStream` at v1.0.
   */
  messageStream?: string;
  /** Optional BYO fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
}
