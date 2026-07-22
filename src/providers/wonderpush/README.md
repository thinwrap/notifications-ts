# WonderPush Push Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'wonderpush'`.

## Configuration

```typescript
const wp = new Push('wonderpush', {
  accessToken: process.env.WONDERPUSH_TOKEN!,
  applicationId: process.env.WONDERPUSH_APP_ID,  // optional
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessToken` | `string` | yes | Management API token (Bearer) |
| `applicationId` | `string` | no | Required by some deliveries endpoints; forwarded as `applicationId` |

## Auth setup

Long-lived management API token from WonderPush dashboard → Account →
Management API. Sent as Bearer.

## Endpoint

`POST https://management-api.wonderpush.com/v1/deliveries` — single global
endpoint.

## Narrowed input augmentations

Standard push input. Audience targeting (segments, user IDs) and scheduling
via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 invalid token | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await wp.send({
  to: 'user-id',
  title: 'Hi',
  body: 'You have a new message.',
  _passthrough: { body: { segments: ['vip'], scheduledTime: '2026-06-01T15:00:00Z' } },
});
```

## Vendor docs

- API reference: https://docs.wonderpush.com/reference/post-deliveries
- Auth: https://docs.wonderpush.com/reference/authentication
