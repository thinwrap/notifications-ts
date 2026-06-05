import { describe, it, expect } from 'vitest';
import { createTokenCacheMock } from './token-cache-mock';

describe('createTokenCacheMock (helper)', () => {
  it('returns null on cache-miss', async () => {
    const cache = createTokenCacheMock();
    expect(await cache.get('fcm:test-project')).toBeNull();
    expect(cache.getSpy).toHaveBeenCalledWith('fcm:test-project');
  });

  it('returns the seeded entry on cache-hit (explicit key)', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const cache = createTokenCacheMock({
      'fcm:test-project': { token: 'cached-token', expiresAt },
    });
    const entry = await cache.get('fcm:test-project');
    expect(entry).toEqual({ token: 'cached-token', expiresAt });
  });

  it('returns null for keys NOT explicitly seeded (no wildcard fallback)', async () => {
    const cache = createTokenCacheMock({
      'fcm:project-a': { token: 'tk-a', expiresAt: 9_999_999_999 },
    });
    expect(await cache.get('fcm:project-a')).not.toBeNull();
    expect(await cache.get('fcm:project-b')).toBeNull();
    expect(await cache.get('apns:T:K:B')).toBeNull();
  });

  it('records calls to set on the spy', async () => {
    const cache = createTokenCacheMock();
    await cache.set('fcm:test-project', 'fresh-token', 12345);
    expect(cache.setSpy).toHaveBeenCalledWith('fcm:test-project', 'fresh-token', 12345);
    expect(cache.store.get('fcm:test-project')).toEqual({
      token: 'fresh-token',
      expiresAt: 12345,
    });
  });

  it('seeds an expired entry for the cache-stale-hit path (explicit key)', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 60;
    const cache = createTokenCacheMock({
      'apns:T:K:B': { token: 'expired-token', expiresAt },
    });
    const entry = await cache.get('apns:T:K:B');
    expect(entry).not.toBeNull();
    expect(entry?.expiresAt).toBeLessThan(Math.floor(Date.now() / 1000));
  });

  it('exposes a Map<string, TokenCacheEntry> store for per-test overrides', async () => {
    const cache = createTokenCacheMock();
    cache.store.set('fcm:project-a', { token: 'tk-a', expiresAt: 100 });
    cache.store.set('fcm:project-b', { token: 'tk-b', expiresAt: 200 });
    expect(await cache.get('fcm:project-a')).toEqual({ token: 'tk-a', expiresAt: 100 });
    expect(await cache.get('fcm:project-b')).toEqual({ token: 'tk-b', expiresAt: 200 });
    expect(await cache.get('fcm:project-c')).toBeNull();
  });

  it('does not auto-evict — vendor-rejects-cached-token leaves store intact', async () => {
    // Vendor rejection (401/403) is the connector's job to translate; the
    // cache hook is not informed. The test for this is in the FCM/APNs
    // connector specs (the cache is unchanged after the connector throws
    // ConnectorError('auth_failed')).
    const cache = createTokenCacheMock({
      'fcm:test': { token: 'revoked-but-cached', expiresAt: 9999 },
    });
    expect(cache.store.size).toBe(1);
  });
});
