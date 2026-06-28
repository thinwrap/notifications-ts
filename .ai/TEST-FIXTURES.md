# Test-fixture conventions (`@thinwrap/notifications`)

This file codifies the shared TypeScript test-fixture conventions used
across the connector spec files. It exists so that:

- A new contributor authoring a new connector spec adopts the existing
  fixture shape rather than inventing a new one.
- The per-spec assertion language is uniform across the four channels,
  which is what lets cross-language harmonization rely on the
  audit-log-matrix-shape rather than per-spec inspection.

Two helpers live under `src/test-utils/`:

- `src/test-utils/retry-after-fixture.ts` — `createRetryAfterFixture(opts)`
- `src/test-utils/token-cache-mock.ts` — `createTokenCacheMock(initialEntry?)`

Both are excluded from the published tarball (see `.npmignore`) but are
type-checked by `tsc -p tsconfig.json --noEmit` as part of the regular
source tree under `src/`.

---

## 1. Retry-After fixture convention

### Helper

```typescript
// src/test-utils/retry-after-fixture.ts
export interface RetryAfterFixtureOptions {
  status: 429 | 503;
  retryAfter?: string | null;     // seconds-integer | HTTP-date | null/undefined for absent
  errorBody?: unknown;            // JSON body (or string when contentType is text/plain)
  contentType?: string;           // defaults to application/json
}

export function createRetryAfterFixture(opts: RetryAfterFixtureOptions): Response;
```

### Assertion pattern (canonical per-connector form)

```typescript
import { vi } from 'vitest';
import { createRetryAfterFixture } from '../../test-utils/retry-after-fixture';
import { ConnectorError } from '../../utils';

describe('<Connector> — Retry-After surfacing', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('surfaces Retry-After on 429', async () => {
    const fixture = createRetryAfterFixture({
      status: 429,
      retryAfter: '30',
      errorBody: { errors: [{ message: 'throttled' }] }, // vendor-shaped
    });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fixture);

    const connector = new XxxConnector({ /* ... */ });

    await expect(connector.send({ /* ... */ })).rejects.toMatchObject({
      providerCode: 'rate_limited',
      // Dual-field cause contract: raw header value + parsed seconds.
      cause: expect.objectContaining({
        retryAfter: '30',        // RAW Retry-After value, verbatim string
        retryAfterSeconds: 30,   // PARSED seconds (number)
      }),
    });
  });

  it('surfaces Retry-After on 503', async () => {
    // ... same shape with status: 503, vendors that document 503 ...
  });
});
```

### Key invariants

Retry-After surfacing follows these invariants:

- **No TOP-LEVEL `retryAfterSeconds` field on `ConnectorError`.** The wrapper
  performs no retry; retry is consumer policy. The parsed value lives inside
  the `cause` bag only.
- The **`cause` dual-field contract**: `cause.retryAfter` carries the raw
  Retry-After value verbatim (string; never normalized), and
  `cause.retryAfterSeconds` carries the parsed seconds (number; absent when
  no Retry-After is present). Specs assert both fields.
- `providerMessage` carries the vendor's error message. (Exception: the
  Scaleway connector additionally embeds `(Retry-After: <n> seconds)` in its
  `providerMessage` text — connector-specific, not the canonical contract.)
- `providerCode` is `'rate_limited'` for 429 and `'provider_unavailable'` for
  503 — see `src/types/error.types.ts` for the canonical enum.
- The fixture must NOT add wrapper-side retry behavior; tests assert that the
  first 429/503 response surfaces the error immediately.

---

## 2. TokenCacheHook fixture convention

### Helper

```typescript
// src/test-utils/token-cache-mock.ts
import { vi } from 'vitest';
import type { TokenCacheHook } from '../types';

export interface TokenCacheEntry {
  value: string;
  expiresAt: number; // Unix seconds.
}

export type MockTokenCacheHook = TokenCacheHook & {
  readonly getSpy: ReturnType<typeof vi.fn>;
  readonly setSpy: ReturnType<typeof vi.fn>;
  readonly store: Map<string, TokenCacheEntry>;
};

export function createTokenCacheMock(initialEntry?: TokenCacheEntry | null): MockTokenCacheHook;
```

### The five hook paths

For each connector that supports `tokenCache?: TokenCacheHook` (currently
FCM and APNs), the spec file asserts these five paths:

1. **Cache-miss** — `get` returns `null` → connector signs fresh → `set`
   is called with the resulting token + computed `expiresAt`.
2. **Cache-hit** — `get` returns a valid (unexpired) entry → connector uses
   it → `set` is **not** called.
3. **Cache-stale-hit** — `get` returns an expired entry → connector treats
   as miss → signs fresh + calls `set`.
4. **Vendor-rejects-cached-token** — `get` returns a valid entry → connector
   sends → vendor returns 401/403 → connector throws
   `ConnectorError({ providerCode: 'auth_failed' })`; `set` is **not** called.
   The wrapper does NOT auto-evict; the consumer's cache layer decides
   eviction policy.
5. **Stateless-by-default** — the connector is constructed with no
   `tokenCache` → every `.send()` signs fresh. No instance-state inspection
   should find a cached token.

### Cache-key shapes

Per the per-connector `src/providers/<id>/<id>.auth.ts`:

- **FCM** — `fcm:<projectId>`
- **APNs** — `apns:<teamId>:<keyId>:<bundleId>`

### Assertion pattern (FCM — abridged)

```typescript
import { createTokenCacheMock } from '../../test-utils/token-cache-mock';

describe('FCM tokenCache hook contract', () => {
  it('cache-miss: signs fresh + calls set', async () => {
    const tokenCache = createTokenCacheMock(null);
    const fcm = new FcmPushConnector({ /* ..., */ tokenCache });
    // ... mock OAuth + FCM-send responses ...
    await fcm.send({ /* ... */ });
    expect(tokenCache.getSpy).toHaveBeenCalledWith('fcm:test-project');
    expect(tokenCache.setSpy).toHaveBeenCalledTimes(1);
  });

  it('cache-hit: uses cached token; set NOT called', async () => {
    const tokenCache = createTokenCacheMock({
      value: 'cached-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const fcm = new FcmPushConnector({ /* ..., */ tokenCache });
    await fcm.send({ /* ... */ });
    expect(tokenCache.setSpy).not.toHaveBeenCalled();
  });

  // ... cache-stale-hit, vendor-rejects, stateless-by-default ...
});
```

### Existing in-repo implementation

FCM and APNs spec files (`src/providers/fcm/fcm.connector.spec.ts` and
`src/providers/apns/apns.connector.spec.ts`) currently use a per-file local
`mockHook()` factory that predates this shared helper. The behavior is
identical (in-memory `Map` + call counters). New connector specs adopting
`tokenCache` should import `createTokenCacheMock` from `src/test-utils/`
directly; the FCM + APNs spec files may migrate to the shared helper in a
follow-up sweep without behavioral change.

---

## 3. When to update this file

Updates to fixture conventions are coordinated changes that touch multiple
connector spec files. The canonical pattern: land the convention update in
this file **and** the per-spec adoption in one PR, so reviewers can see the
old and new shapes side-by-side.

If a vendor introduces a new error-surfacing mechanism (e.g. a structured
`X-RateLimit-Reset` header replacing `Retry-After`), the fixture helper
gains a new option, the conventions doc gains a new section, and the
affected connector specs adopt the new shape in the same PR.

Documenting "why X is not part of the fixture" matters as much as
documenting "what X is". For example: the wrapper does no retry; the
fixture must therefore never include retry-loop helpers. Future contributors
asking "why doesn't the helper auto-retry?" find the answer here.
