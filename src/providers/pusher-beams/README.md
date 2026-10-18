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

`data` goes to `fcm.data` (values stringified, as FCM requires), `apns.data`
(the Beams APNs format's custom-data key) and `web.data`. With neither `title`
nor `body` the send is data-only: no `fcm.notification`, no `web.notification`,
and `apns.aps` is `{ "content-available": 1 }` so iOS wakes the app in the
background instead of showing an empty alert.

`instanceId` is used as the hostname label and a path segment, so it must be a
single DNS label; anything else is rejected before the secret key is sent.

Per the baseline-coverage rule, this translation lives in the
connector and is invisible at the facade level.

## Endpoint

`POST https://<instanceId>.pushnotifications.pusher.com/publish_api/v1/instances/<instanceId>/publishes/users`
(or `/publishes/interests` for interest targeting).

## Narrowed input augmentations

Standard push input. Targeting selection (users vs interests) is currently
fixed at the connector level; richer targeting via `_passthrough`.

## Error mapping

Per Beams' [publish API](https://pusher.com/docs/beams/reference/publish-api/) error table:

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 400 | invalid content type, missing param, body too large, not a JSON object | `invalid_request` |
| 401 / 403 | "Incorrect API Key." | `auth_failed` |
| 402 | publishing blocked for exceeding plan limits | `rate_limited` |
| 404 | "Could not find the instance." | `invalid_request` |
| 413 / 422 | body too large / "JSON does not … match schema" | `invalid_request` |
| 429 | over 100 requests per second | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| other | (any) | `unknown` |
| network failure | — | `provider_unavailable` |
| (pre-flight) | `instanceId` is not a single DNS label | `invalid_request` |

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
