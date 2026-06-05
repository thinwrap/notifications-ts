---
providerId: pusher-beams
channel: push
auth:
  method: bearer
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://example.pushnotifications.pusher.com/publish_api/v1
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward Beams platform-specific payload keys (`apns`, `fcm`, `web`) via
  `_passthrough.body`.
attachments_supported: false
templates_supported: false
novuProviderId: pusher-beams
tier: 1
---

# Pusher Beams Push Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'pusher-beams'`.

## Configuration

```typescript
const pb = new Push('pusher-beams', {
  instanceId: process.env.BEAMS_INSTANCE_ID!,
  secretKey: process.env.BEAMS_SECRET!,
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `instanceId` | `string` | yes | UUID from Beams dashboard |
| `secretKey` | `string` | yes | Server-side secret (Bearer) |

## Auth setup

Long-lived secret key from Pusher Beams dashboard → Keys. Sent as
`Authorization: Bearer <secretKey>`. Static.

## Outlier translation — APNs + FCM payload synthesis

Beams accepts a single request that targets multiple device platforms. The
connector synthesizes the Beams `apns.aps` (Apple) + `fcm.notification`
(Android / Web) payloads from the base push input (`title`, `body`, etc.).
Consumers pushing platform-specific extras override via `_passthrough.body.apns`,
`_passthrough.body.fcm`, `_passthrough.body.web`.

Per the baseline-coverage rule, this translation lives in the
connector and is invisible at the facade level.

## Endpoint

`POST https://<instanceId>.pushnotifications.pusher.com/publish_api/v1/instances/<instanceId>/publishes/users`
(or `/publishes/interests` for interest targeting).

## Narrowed input augmentations

Standard push input. Targeting selection (users vs interests) is currently
fixed at the connector level; richer targeting via `_passthrough`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 / 422 `Unknown user` | `invalid_recipient` |
| 400 / 422 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await pb.send({
  to: 'user-uuid',
  title: 'Hi',
  body: 'You have a new message.',
  _passthrough: {
    body: {
      apns: { aps: { 'mutable-content': 1 } },
      fcm: { notification: { android_channel_id: 'default' } },
    },
  },
});
```

## Vendor docs

- API reference: https://pusher.com/docs/beams/reference/publish-api/
- Errors: https://pusher.com/docs/beams/reference/publish-api/#error-responses
