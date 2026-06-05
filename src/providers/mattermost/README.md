---
providerId: mattermost
channel: chat
auth:
  method: webhook-url-secret
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://mattermost.example.com/hooks
versioning:
  vendorApiVersion: webhook-v4
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward Mattermost fields (`channel`, `username`, `icon_url`,
  `attachments`, `props`) via `_passthrough.body`.
attachments_supported: false
templates_supported: false
novuProviderId: mattermost
tier: 1
---

# Mattermost Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'mattermost'`.

## Configuration

```typescript
const mm = new Chat('mattermost', {
  webhookUrl: 'https://mattermost.example.com/hooks/<id>',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `webhookUrl` | `string` | yes | Incoming webhook URL — the URL itself is the credential |

## Auth setup

Create an Incoming Webhook in Mattermost → Integrations → Incoming Webhooks.
The URL is the credential. (Each instance is self-hosted, so the host part of
`webhookUrl` varies.)

## Endpoint

The webhook URL is the endpoint. Each webhook is pinned to a default
channel; can be overridden via `_passthrough.body.channel`.

## Narrowed input augmentations

Standard chat input (`body` is `text`). Channel override, attachments,
mention props via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 / 404 | (any) | `auth_failed` |
| 400 invalid payload | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await mm.send({
  body: 'Build passed',
  _passthrough: {
    body: {
      channel: 'town-square',
      attachments: [{ color: '#36a64f', text: 'Build passed', title: 'CI' }],
    },
  },
});
```

## Vendor docs

- API reference: https://developers.mattermost.com/integrate/webhooks/incoming/
- Message attachments: https://developers.mattermost.com/integrate/reference/message-attachments/
