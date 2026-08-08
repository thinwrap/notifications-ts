export interface VonageConfig {
  /** Vonage `api_key` — sent as a form field in the POST body, not a header. */
  apiKey: string;
  /** Vonage `api_secret` — sent as a form field in the POST body, not a header. */
  apiSecret: string;
  /**
   * Default sender (E.164 or alphanumeric). Optional, so supplying `from` per call
   * is sufficient; a per-call value overrides this one.
   */
  from?: string;
  /** BYO fetch hook — the wrapper holds no state. */
  fetch?: typeof fetch;
}
