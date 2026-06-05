export interface SendgridConfig {
  /** SendGrid API key (Bearer secret; typically starts with `SG.`). */
  apiKey: string;
  /** Default sender email address. */
  from: string;
  /** Optional display name composed alongside `from` as `{ email, name }`. */
  senderName?: string;
  /** Optional BYO fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
}
