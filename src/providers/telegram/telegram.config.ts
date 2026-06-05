export interface TelegramConfig {
  /** Bot token issued by @BotFather; embedded in the request URL path. */
  botToken: string;
  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
