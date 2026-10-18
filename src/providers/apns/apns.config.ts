import type { TokenCacheHook } from '../../types';

/**
 * APNs configuration. Maps 1:1 to the contents of an Apple `.p8` token-based
 * auth key plus its surrounding identifiers.
 *
 * - `teamId` — 10-char Apple Developer Team ID (the `iss` claim of the JWT).
 * - `keyId`  — 10-char APNs auth-key ID (the `kid` header of the JWT).
 * - `privateKey` — PKCS#8 PEM-encoded EC P-256 private key (the contents of
 *   the `.p8` file).
 * - `bundleId` — app bundle identifier; used as the default `apns-topic`
 *   header. Per-send override via `input.apnsTopic`.
 * - `env` — explicit `'production' | 'sandbox'` rather than a boolean, so which
 *   environment a send targets is never ambiguous by default.
 *
 * The connector holds no token state, so without a `tokenCache` it signs a
 * fresh ES256 JWT on every send. APNs rejects provider tokens that change more
 * than once every 20 minutes (`429 TooManyProviderTokenUpdates`), so a shared
 * `tokenCache` is required in production; the wrapper memoizes through the
 * hook with key `'apns:' + teamId + ':' + keyId + ':' + bundleId`.
 */
export interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  env: 'production' | 'sandbox';
  /**
   * Token cache for the signed ES256 JWT. Optional in the type so tests and
   * one-off scripts work, but REQUIRED in production: APNs accepts a new
   * provider token at most once every 20 minutes. On vendor 403 the wrapper
   * does NOT evict; eviction is the consumer's responsibility.
   */
  tokenCache?: TokenCacheHook;
  /** Bring-your-own fetch implementation BYO-fetch contract. */
  fetch?: typeof fetch;
}
