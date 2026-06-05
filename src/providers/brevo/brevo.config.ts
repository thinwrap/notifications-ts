export interface BrevoConfig {
  /** Brevo API key (sent in the `api-key` request header, NOT `Authorization: Bearer …`). */
  apiKey: string;
  /** Default sender email address (Brevo's `sender.email`). */
  from: string;
  /** Optional display name composed alongside `from` as `sender: { name, email }`. */
  senderName?: string;
  /** Optional BYO fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
}
