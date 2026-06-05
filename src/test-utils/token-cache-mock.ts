/**
 * TokenCacheHook mock helper for vitest specs.
 *
 * The wrapper holds no token state. Connectors sign
 * fresh by default; consumers opt into amortized signing by passing a
 * `tokenCache?: TokenCacheHook` via config.
 *
 * The FCM + APNs spec files use this helper to assert the four hook-
 * interaction paths:
 *   1. Cache-miss:                  get -> null   -> sign fresh -> set called.
 *   2. Cache-hit:                   get -> valid  -> reuse      -> set NOT called.
 *   3. Cache-stale-hit:             get -> expired-> sign fresh -> set called.
 *   4. Vendor-rejects-cached-token: get -> valid  -> vendor 401 -> ConnectorError('auth_failed');
 *                                                                  set NOT called (no auto-evict).
 *
 * A fifth path — stateless-by-default — is asserted by NOT passing
 * `tokenCache` and observing that every send signs fresh.
 *
 * See `.ai/TEST-FIXTURES.md` for the canonical per-connector assertion pattern.
 */

import { vi } from 'vitest';
import type { TokenCacheHook } from '../types';

export interface TokenCacheEntry {
  token: string;
  expiresAt: number; // Unix seconds.
}

export type MockTokenCacheHook = TokenCacheHook & {
  /** Vitest spy on the `get` method — assert `.toHaveBeenCalledWith(...)`. */
  readonly getSpy: ReturnType<typeof vi.fn>;
  /** Vitest spy on the `set` method — assert `.toHaveBeenCalledWith(...)`. */
  readonly setSpy: ReturnType<typeof vi.fn>;
  /** Live snapshot of the underlying store. */
  readonly store: Map<string, TokenCacheEntry>;
};

/**
 * Builds a vitest-mock `TokenCacheHook` seeded with optional initial entries.
 * no wildcard fallback — each key must be
 * seeded explicitly to enforce per-key isolation.
 *
 * @param seedEntries
 *   - omitted / empty -> cache-miss path for every key: `get` returns null.
 *   - `{ 'fcm:proj-a': { token, expiresAt } }` -> cache-hit for that specific
 *     key; other keys still miss.
 *
 *   For tests asserting connector behavior across multiple sends with
 *   evolving cache state, pass `undefined` and use `store.set(key, entry)`
 *   directly between sends.
 *
 * @example
 *   it('cache-miss: signs fresh + calls set', async () => {
 *     const tokenCache = createTokenCacheMock();
 *     const fcm = new FcmPushConnector({ ..., tokenCache });
 *     await fcm.send({ ... });
 *     expect(tokenCache.getSpy).toHaveBeenCalledWith('fcm:test-project');
 *     expect(tokenCache.setSpy).toHaveBeenCalledTimes(1);
 *   });
 *
 * @example
 *   it('cache-hit: uses seeded token', async () => {
 *     const tokenCache = createTokenCacheMock({
 *       'fcm:test-project': { token: 'cached-token', expiresAt: 9_999_999_999 },
 *     });
 *     const fcm = new FcmPushConnector({ ..., tokenCache });
 *     await fcm.send({ ... });
 *     expect(tokenCache.setSpy).not.toHaveBeenCalled();
 *   });
 */
export function createTokenCacheMock(
  seedEntries?: Record<string, TokenCacheEntry>,
): MockTokenCacheHook {
  const store = new Map<string, TokenCacheEntry>();
  if (seedEntries) {
    for (const [key, entry] of Object.entries(seedEntries)) {
      store.set(key, entry);
    }
  }

  const getSpy = vi.fn(async (key: string): Promise<TokenCacheEntry | null> => {
    return store.get(key) ?? null;
  });

  const setSpy = vi.fn(async (key: string, token: string, expiresAt: number): Promise<void> => {
    store.set(key, { token, expiresAt });
  });

  return {
    get: getSpy as TokenCacheHook['get'],
    set: setSpy as TokenCacheHook['set'],
    getSpy,
    setSpy,
    store,
  };
}
