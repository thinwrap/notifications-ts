// token-auth: `accessToken` is a long-lived Meta Business Manager
// system-user token; leak = posting authority on the business phone number.
export interface WhatsAppBusinessConfig {
  /** Meta Graph API system-user access token (Bearer credential). */
  accessToken: string;
  /** Numeric phone-number ID from Meta Business Manager — NOT the phone number itself. */
  phoneNumberId: string;
  /**
   * Graph API version segment embedded in the request URL (e.g. `'v21.0'`).
   * Defaults to `'v21.0'` outlier pinning discipline; consumers
   * override to track Meta's ~2-year deprecation window.
   */
  graphApiVersion?: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
