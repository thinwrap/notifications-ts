---
providerId: expo
channel: push
auth:
  method: bearer
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://exp.host/--/api/v2/push/send
versioning:
  vendorApiVersion: v2
  lastVerified: 2026-05-17
notes_passthrough: |
  Expo accepts `categoryId`, `channelId`, `mutableContent`, `priority`, etc.
  Forward via `_passthrough.body`.
attachments_supported: false
templates_supported: false
novuProviderId: expo
tier: 1
---

# Expo Push Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'expo'`.

## Configuration

```typescript
const expo = new Push('expo', {
  accessToken: process.env.EXPO_TOKEN,    // optional
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessToken` | `string` | no | Long-lived per-project token; sent as Bearer when present |

## Auth setup

Expo's push API accepts unauthenticated requests for many projects; pass an
`accessToken` from `https://expo.dev/accounts/<account>/settings/access-tokens`
when your project requires it. Static — no refresh, no lifecycle.

Receipt polling (`POST /push/getReceipts`) is out of v1.0 scope; documented
here as a future addition.

## Endpoint

`POST https://exp.host/--/api/v2/push/send` — single global endpoint.

## Narrowed input augmentations

Standard push input (`to`, `title`, `body`, `data` — the 4-field baseline).
Expo-narrowed: `badge`, `sound`, `ttl`.
Channel IDs, mutable-content flags, priority via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 `DeviceNotRegistered` (per-ticket) | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await expo.send({
  to: 'ExponentPushToken[xxxxxx]',
  title: 'Hi',
  body: 'You have a new message.',
  _passthrough: { body: { channelId: 'default', priority: 'high', mutableContent: true } },
});
```

## Vendor docs

- API reference: https://docs.expo.dev/push-notifications/sending-notifications/
- Errors: https://docs.expo.dev/push-notifications/sending-notifications/#push-receipt-errors
