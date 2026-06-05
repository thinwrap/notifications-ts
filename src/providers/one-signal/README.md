---
providerId: one-signal
channel: push
auth:
  method: api-key-header
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://onesignal.com/api/v1/notifications
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward OneSignal fields (`headings`, `data`, `filters`, `template_id`,
  `large_icon`, etc.) via `_passthrough.body`.
attachments_supported: false
templates_supported: true
novuProviderId: one-signal
tier: 1
---

# OneSignal Push Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'one-signal'`.

## Configuration

```typescript
const os = new Push('one-signal', {
  appId: process.env.ONESIGNAL_APP_ID!,
  apiKey: process.env.ONESIGNAL_REST_KEY!,        // REST API key, NOT user-auth key
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `appId` | `string` | yes | OneSignal application UUID |
| `apiKey` | `string` | yes | REST API key (sent in `Authorization: Basic <apiKey>`) |

## Auth setup

Long-lived REST API key drawn from OneSignal dashboard → Settings → Keys &
IDs. Static — no token caching.

## Endpoint

`POST https://onesignal.com/api/v1/notifications` — single global endpoint.

## Narrowed input augmentations

Standard push input. OneSignal filters/segments, templates, platform-specific
keys via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 `invalid_player_ids` | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await os.send({
  to: 'player-uuid',
  title: 'Hi',
  body: 'You have a new message.',
  _passthrough: {
    body: { template_id: 'tmpl-uuid', filters: [{ field: 'tag', key: 'cohort', relation: '=', value: 'q1' }] },
  },
});
```

## Vendor docs

- API reference: https://documentation.onesignal.com/reference/create-notification
- Errors: https://documentation.onesignal.com/docs/api-rate-limits-and-errors
