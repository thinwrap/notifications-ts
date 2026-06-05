export interface TelnyxConfig {
  apiKey: string;
  /** Default sender (E.164, short code, or alphanumeric sender ID); per-call overridable. */
  from?: string;
  /** BYO `fetch`. */
  fetch?: typeof fetch;
}
