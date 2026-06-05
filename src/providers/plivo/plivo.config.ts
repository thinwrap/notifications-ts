export interface PlivoConfig {
  /** Plivo Account Auth ID (used in URL path and as Basic auth username). */
  authId: string;
  /** Plivo Auth Token (Basic auth password). */
  authToken: string;
  /** Default sender (E.164 or short code); per-call overridable. */
  from?: string;
  /** BYO `fetch`. */
  fetch?: typeof fetch;
}
