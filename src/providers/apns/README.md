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
  tokenCache: myCacheImpl,                        // required in production
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `teamId` | `string` | yes | Apple Team ID |
| `keyId` | `string` | yes | APNs auth-key ID |
| `privateKey` | `string` | yes | PKCS#8 PEM contents of the `.p8` file |
| `bundleId` | `string` | yes | App bundle ID; default `apns-topic` header |
| `env` | `'production' \| 'sandbox'` | yes | Explicit — no default |
| `tokenCache` | `TokenCacheHook` | **yes in production** (type-optional) | Consumer-provided cache for the signed JWT — see below |

## Auth setup

The connector signs an ES256 JWT (algorithm `ES256`, header `kid` =
`config.keyId`, payload `iss` = `config.teamId`) using the PKCS#8 P-256
private key from the Apple `.p8` file. APNs accepts JWTs for ~60 min.

**`tokenCache` is required in production — it is not a speed optimisation.**
Apple: "Refresh your token no more than once every 20 minutes and no less than
once every 60 minutes", and APNs answers `429 TooManyProviderTokenUpdates` when
a new token arrives more often than that. The wrapper holds no state, so
without a hook it signs a fresh JWT on every `.send()` / `sendMessage()`; the
second send inside 20 minutes can then be rejected. Back the hook with a store
shared by every process that sends with the same key (Redis, memcached, …).

The wrapper memoizes through the hook with the deterministic key
`'apns:' + teamId + ':' + keyId + ':' + bundleId` and a 50-minute expiry
(inside Apple's 20–60 minute window). On vendor 403 the wrapper does **not**
auto-evict; eviction is the consumer's responsibility.

## Endpoint

Mode-derived:
- `production`: `https://api.push.apple.com/3/device/<token>`
- `sandbox`: `https://api.sandbox.push.apple.com/3/device/<token>`

HTTP/2 only. The `bundleId` is sent as the `apns-topic` header.

> **You must supply an HTTP/2-capable transport.** APNs only accepts HTTP/2, but
> Node's built-in `fetch` (undici) speaks HTTP/1.1. Calling `.send()` on the
> default transport fails fast with `ConnectorError` (`providerCode:
> 'invalid_request'`) — inject a `fetch` implementation that negotiates HTTP/2.

## Narrowed input augmentations

Standard push input (`to`, `title`, `body`, `data` — the 4-field baseline).
APNs-narrowed: `badge` (→ `aps.badge`), `sound` (→ `aps.sound`), `ttl`
(→ `apns-expiration`).

`apns-push-type` is `alert` when the merged `aps` has any of `alert`, `badge`
or `sound` (from the typed fields, `input.aps` or `_passthrough.body.aps`) —
Apple's alert type covers "an alert, badge, or sound" — and `background` only
when it has none of them. An `apnsPushType` or `apns-push-type` header you set
always wins. When the effective type is `background` the connector adds
`apns-priority: 5` and `aps["content-available"] = 1` unless you set them,
because Apple treats priority 10 on a background push as an error and defaults
an omitted priority to 10.
`apns-topic`, `apns-priority`, `apns-collapse-id`, `apns-expiration`,
mutable-content, and content-available via `_passthrough.body` (top-level
`aps` keys) or `_passthrough.headers`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 403 | `InvalidProviderToken` / `ExpiredProviderToken` / other | `auth_failed` |
| 400 / 403 | `BadDeviceToken` | `invalid_recipient` |
| 410 | `Unregistered` | `invalid_recipient` |
| 400 / 413 | (other reason) | `invalid_request` |
| 429 | `TooManyProviderTokenUpdates` | `auth_failed` — the message names `tokenCache` as the fix |
| 429 | (other) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| (pre-flight) | `privateKey` unusable for ES256 signing | `auth_failed` (cause carries only the error class name) |
| network failure | — | `provider_unavailable` |

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
