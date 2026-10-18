# OneSignal Push Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'one-signal'`.

## Configuration

```typescript
const os = new Push('one-signal', {
  appId: process.env.ONESIGNAL_APP_ID!,
  apiKey: process.env.ONESIGNAL_API_KEY!,         // App API key (os_v2_…) or legacy REST API key
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `appId` | `string` | yes | OneSignal application UUID |
| `apiKey` | `string` | yes | App API key (`os_v2_…`, sent as `Authorization: Key <apiKey>`) or legacy REST API key (sent as `Authorization: Basic <apiKey>`) |

## Auth setup

Long-lived App API key drawn from OneSignal dashboard → Settings → Keys &
IDs. Static — no token caching. OneSignal only issues `os_v2_…` App API keys
now; legacy REST API keys created before Nov 2024 keep working.

## Endpoint

Chosen by key generation:

| Key | Endpoint | `Authorization` |
|---|---|---|
| App API key (`os_v2_…`) | `POST https://api.onesignal.com/notifications?c=push` | `Key <apiKey>` |
| any other (legacy REST API key) | `POST https://onesignal.com/api/v1/notifications` | `Basic <apiKey>` |

## Narrowed input augmentations

Standard push input; `to` becomes `include_subscription_ids: [to]`.
OneSignal filters/segments, templates, platform-specific keys via
`_passthrough.body`.

Setting any targeting parameter yourself — `include_aliases`,
`include_subscription_ids`, `included_segments`, `excluded_segments`,
`filters`, `include_player_ids`, `include_external_user_ids`,
`include_email_tokens`, `include_phone_numbers` — as an augmentation or in
`_passthrough.body` suppresses the default `include_subscription_ids`
(OneSignal rejects combining alias/segment targets with other targeting).
`include_aliases` also requires `target_channel` (e.g. `'push'`).

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 `invalid_player_ids` | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 200 | no notification `id`, `errors` naming invalid recipients | `invalid_recipient` |
| 200 | an `id` plus `errors` listing some invalid recipients | success — the list stays on `raw.errors` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `provider_unavailable` |

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
- Errors: https://documentation.onesignal.com/reference/rate-limits
