/**
 * Infobip SMS connector config. Infobip is the only SMS provider in v1.0 with a
 * **per-account base URL** — Infobip provisions a customer-specific subdomain
 * when an account is created (e.g., `xyz123.api.infobip.com`). The `baseUrl`
 * field is therefore REQUIRED, not optional.
 */
export interface InfobipConfig {
  /**
   * REQUIRED — per-account Infobip subdomain (e.g., `'xyz123.api.infobip.com'`).
   * Do NOT include scheme (`'https://'`) or trailing slash; the connector adds both.
   */
  baseUrl: string;
  /** Infobip API key. Authenticates via custom `Authorization: App <apiKey>` scheme. */
  apiKey: string;
  /** Default sender; per-call overridable via `InfobipNarrowedInput.from`. */
  from?: string;
  /** BYO `fetch` the wrapper holds no state. */
  fetch?: typeof fetch;
}
