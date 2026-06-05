/**
 * OneSignal connector configuration.
 *
 * The REST API key (`apiKey`) is a long-lived credential drawn from the
 * OneSignal dashboard — **not** the user-auth key. project
 * memory the wrapper holds no state, this connector holds no
 * token state; the key is sent verbatim on every `.send()` call.
 */
export interface OneSignalConfig {
  /** UUID app id from the OneSignal dashboard. */
  appId: string;
  /** REST API key from the OneSignal dashboard (NOT user-auth key). */
  apiKey: string;
  /** Bring-your-own fetch implementation BYO-fetch contract. */
  fetch?: typeof fetch;
}
