export interface ExpoConfig {
  /**
   * Optional Expo access token. Used verbatim as a Bearer token when set;
   * omitted entirely when not set (Expo accepts unauthenticated requests for
   * projects that allow them). Long-lived per-project API key — no refresh /
   * lifecycle, no caching.
   */
  accessToken?: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
