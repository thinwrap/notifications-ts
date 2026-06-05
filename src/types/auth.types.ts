/**
 * Optional consumer-provided token cache hook for FCM and APNs auth signing.
 * The wrapper holds no token state. Connectors
 * sign fresh by default; consumers wanting to amortize signing cost pass
 * `tokenCache?: TokenCacheHook` via config.
 *
 * On vendor 401/403, the wrapper does NOT auto-evict; the consumer's cache
 * layer decides eviction policy. The wrapper throws ConnectorError({
 * providerCode: 'auth_failed' }) and the consumer evicts via `set(key, '', 0)`
 * or equivalent.
 */
export interface TokenCacheHook {
  get(key: string): Promise<{ token: string; expiresAt: number } | null>;
  set(key: string, token: string, expiresAt: number): Promise<void>;
}
