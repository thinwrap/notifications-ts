// token-auth: `channelAccessToken` is a long-lived Channel Access Token
// issued from the LINE Developers Console; leak = posting authority on the LINE
// channel.
export interface LineConfig {
  /** Long-lived Channel Access Token from the LINE Developers Console (Bearer credential). */
  channelAccessToken: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
