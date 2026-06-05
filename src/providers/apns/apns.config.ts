import type { TokenCacheHook } from '../../types';

/**
 * APNs configuration. Maps 1:1 to the contents of an Apple `.p8` token-based
 * auth key plus its surrounding identifiers.
 *
 * - `teamId` — 10-char Apple Developer Team ID (the `iss` claim of the JWT).
 * - `keyId`  — 10-char APNs auth-key ID (the `kid` header of the JWT).
 * - `privateKey` — PKCS#8 PEM-encoded EC P-256 private key (the contents of
 *   the `.p8` file). Post-rename from brownfield `key`.
 * - `bundleId` — app bundle identifier; used as the default `apns-topic`
 *   header. Per-send override via `input.apnsTopic`.
 * - `env` — explicit `'production' | 'sandbox'`. Replaces brownfield's
 * `production?: boolean` to eliminate default-ambiguity.
 *
 * Per the stateless-wrapper design (2026-05-13
 * reversal), the wrapper signs a fresh ES256 JWT on every `.send()` by
 * default — the connector holds no token state. Consumers wanting to
 * amortize the local crypto cost across high-volume sends pass a
 * `tokenCache: TokenCacheHook`; the wrapper memoizes through the hook with
 * key `'apns:' + teamId + ':' + keyId + ':' + bundleId`.
 */
export interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  env: 'production' | 'sandbox';
  /**
   * Optional consumer-provided token cache for the ES256 JWT signing. On
   * vendor 403 the wrapper does NOT evict; eviction is the consumer's
   * responsibility.
   */
  tokenCache?: TokenCacheHook;
  /** Bring-your-own fetch implementation BYO-fetch contract. */
  fetch?: typeof fetch;
}
