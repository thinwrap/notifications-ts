/**
 * MessageBird (now branded "Bird") SMS connector config. The legacy
 * `rest.messagebird.com` API surface remains operational and is the v1.0
 * baseline — provider ID stays `messagebird` (no `bird` alias).
 */
export interface MessageBirdConfig {
  /** MessageBird AccessKey (sent as `Authorization: AccessKey <accessKey>`). */
  accessKey: string;
  /** Default sender (originator); per-call overridable via `MessageBirdNarrowedInput.from`. */
  from?: string;
  /** BYO `fetch` the wrapper holds no state. */
  fetch?: typeof fetch;
}
