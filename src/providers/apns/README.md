---
providerId: apns
channel: push
auth:
  method: jwt-es256
  tokenLifecycle: short-lived-signed
  tokenCacheHookSupported: true
endpoint:
  default: https://api.push.apple.com:443
  regional:
    - https://api.push.apple.com
    - https://api.sandbox.push.apple.com
versioning:
  vendorApiVersion: hpapi
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward APNs `aps` keys (`alert`, `sound`, `badge`, `mutable-content`,
  `content-available`, `category`, `thread-id`) and custom top-level keys
  via `_passthrough.body`.
attachments_supported: false
templates_supported: false
novuProviderId: apns
tier: 2
---

# APNs (Apple Push Notification service) Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'apns'`.

## Configuration

```typescript
const apns = new Push('apns', {
  teamId: 'ABCD123456',                          // 10-char Apple Team ID
  keyId: 'EFGH567890',                            // 10-char APNs auth-key ID
  privateKey: process.env.APNS_P8!,               // PKCS#8 PEM EC P-256
  bundleId: 'com.example.app',
  env: 'production',                              // 'production' | 'sandbox'
  tokenCache: myCacheImpl,                        // optional
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `teamId` | `string` | yes | Apple Team ID |
| `keyId` | `string` | yes | APNs auth-key ID |
| `privateKey` | `string` | yes | PKCS#8 PEM contents of the `.p8` file |
| `bundleId` | `string` | yes | App bundle ID; default `apns-topic` header |
| `env` | `'production' \| 'sandbox'` | yes | Explicit — no default |
| `tokenCache` | `TokenCacheHook` | no | Consumer-provided cache for the signed JWT |

## Auth setup

The connector signs an ES256 JWT (algorithm `ES256`, header `kid` =
`config.keyId`, payload `iss` = `config.teamId`) using the PKCS#8 P-256
private key from the Apple `.p8` file. APNs accepts JWTs for ~60 min.

By default the wrapper signs fresh on every `.send()` (stateless —
the wrapper holds no state). Pass `tokenCache: TokenCacheHook` to
amortize signing cost across many sends — the wrapper memoizes through the
hook with the deterministic key `'apns:' + teamId + ':' + keyId + ':' + bundleId`.
On vendor 403 the wrapper does **not** auto-evict; eviction is the consumer's
responsibility.

## Endpoint

Mode-derived:
- `production`: `https://api.push.apple.com/3/device/<token>`
- `sandbox`: `https://api.sandbox.push.apple.com/3/device/<token>`

HTTP/2 only. The `bundleId` is sent as the `apns-topic` header.

## Narrowed input augmentations

Standard push input (`to`, `title`, `body`, `data` — the 4-field baseline).
APNs-narrowed: `badge` (→ `aps.badge`), `sound` (→ `aps.sound`), `ttl`
(→ `apns-expiration`).
`apns-topic`, `apns-priority`, `apns-collapse-id`, `apns-expiration`,
mutable-content, and content-available via `_passthrough.body` (top-level
`aps` keys) or `_passthrough.headers`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 403 `InvalidProviderToken` | `auth_failed` |
| 400 `BadDeviceToken` | `invalid_recipient` |
| 400 (other reason) | `invalid_request` |
| 429 / 503 | (any) | `rate_limited` / `provider_unavailable` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await apns.send({
  to: 'a1b2c3...',                  // hex device token
  title: 'Hi',
  body: 'You have a new message.',
  _passthrough: {
    body: { aps: { 'mutable-content': 1, sound: 'chime.caf' } },
    headers: { 'apns-priority': '10', 'apns-collapse-id': 'order-12345' },
  },
});
```

## Vendor docs

- API reference: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
- Authentication: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
- Errors: https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
