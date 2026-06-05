import type { TokenCacheHook } from '../../types';

/**
 * FCM service-account configuration. `clientEmail` and `privateKey` map 1:1
 * to the `client_email` and `private_key` fields of a Google service-account
 * JSON file (download from Firebase console). The PEM-encoded `privateKey`
 * is passed verbatim into Node's `crypto.createSign('RSA-SHA256')`.
 *
 * Per the stateless-wrapper design (2026-05-13
 * reversal), the wrapper signs + exchanges the OAuth access token on every
 * `.send()` by default — the connector holds no token state. A consumer
 * who wants amortization plugs in a `tokenCache: TokenCacheHook`; the
 * wrapper memoizes through the hook with key `'fcm:' + projectId`.
 */
export interface FcmConfig {
  projectId: string;
  /** Service-account `client_email` (post-rename; brownfield was `email`). */
  clientEmail: string;
  /**
   * Service-account `private_key` — PEM-encoded RSA private key
   * (post-rename; brownfield was `secretKey`).
   */
  privateKey: string;
  /**
   * Optional consumer-provided token cache for the RS256 -> OAuth2
   * access-token exchange. the wrapper holds no token state — pass
   * a hook here to amortize signing cost. The cache key is exactly
   * `'fcm:' + projectId` (deterministic, no time-varying component).
   * On vendor 401 the wrapper does NOT evict; eviction is the consumer's
   * responsibility.
   */
  tokenCache?: TokenCacheHook;
  /** Bring-your-own fetch implementation BYO-fetch contract. */
  fetch?: typeof fetch;
}
