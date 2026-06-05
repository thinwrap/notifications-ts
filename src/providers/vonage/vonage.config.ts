export interface VonageConfig {
  /** Vonage `api_key` — sent as a form field in the POST body, not a header. */
  apiKey: string;
  /** Vonage `api_secret` — sent as a form field in the POST body, not a header. */
  apiSecret: string;
  /**
   * Default sender (E.164 or alphanumeric). Overridable per-call via
   * `SmsSendInput.from`. The brownfield required this field; keeps
   * it optional on the type so that per-call `from` is sufficient.
   */
  from?: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
