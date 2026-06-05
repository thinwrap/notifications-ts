/**
 * Textmagic SMS connector config. Textmagic auth is a two-header pair
 * (`X-TM-Username` + `X-TM-Key`) — distinct from every other wrapped SMS
 * provider's single-header / Basic / Bearer scheme.
 */
export interface TextmagicConfig {
  /** Textmagic account username. */
  username: string;
  /** Textmagic API key (generated in account portal). */
  apiKey: string;
  /** Default sender — alphanumeric or E.164. Per-call overridable via `TextmagicNarrowedInput.from`. */
  from?: string;
  /** BYO `fetch` the wrapper holds no state. */
  fetch?: typeof fetch;
}
