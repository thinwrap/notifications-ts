# Google Chat Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'google-chat'`.

## Configuration

```typescript
const gc = new Chat('google-chat', {
  webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=...&token=...',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `webhookUrl` | `string` | yes | Google Chat incoming-webhook URL (includes `key` + `token` query params) — the URL itself is the credential |

## Auth setup

In Google Chat space → space settings → Apps & integrations → Manage webhooks
→ Add. The URL embeds `?key=<key>&token=<token>` — both are part of the
credential surface and forwarded verbatim.

## Endpoint

The webhook URL is the endpoint. Each webhook is pinned to a space.

## Narrowed input augmentations

Standard chat input (`body` is `text`). Cards v2 payloads via
`_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 / 404 | (any) | `auth_failed` |
| 400 invalid card | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await gc.send({
  body: 'Build passed',
  _passthrough: {
    body: {
      cardsV2: [{ cardId: 'build-card', card: { header: { title: 'CI', subtitle: 'main' } } }],
    },
  },
});
```

## Vendor docs

- API reference: https://developers.google.com/chat/api/guides/message-formats
- Cards v2: https://developers.google.com/chat/api/guides/v1/messages/create#card
