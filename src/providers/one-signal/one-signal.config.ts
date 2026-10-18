/**
 * OneSignal connector configuration.
 *
 * The API key (`apiKey`) is a long-lived credential drawn from the OneSignal
 * dashboard — **not** the user-auth key. Its generation picks the endpoint:
 * `os_v2_…` App API keys go to `api.onesignal.com` (`Key` scheme), legacy
 * REST API keys to `onesignal.com/api/v1` (`Basic` scheme). The wrapper holds
 * no token state; the key is sent verbatim on every `.send()` call.
 */
export interface OneSignalConfig {
  /** UUID app id from the OneSignal dashboard. */
  appId: string;
  /** App API key (`os_v2_…`) or legacy REST API key from the OneSignal dashboard (NOT user-auth key). */
  apiKey: string;
  /** Bring-your-own fetch implementation BYO-fetch contract. */
  fetch?: typeof fetch;
}
