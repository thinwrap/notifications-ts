---
providerId: slack
channel: chat
auth:
  method: webhook-url-secret
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://hooks.slack.com/services
versioning:
  vendorApiVersion: incoming-webhook
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward Slack Block Kit (`blocks`, `attachments`, `thread_ts`) via
  `_passthrough.body`.
attachments_supported: false
templates_supported: false
novuProviderId: slack
tier: 1
---

# Slack Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'slack'`.

## Configuration

```typescript
const sl = new Chat('slack', {
  webhookUrl: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `webhookUrl` | `string` | yes | Incoming Webhook URL — the URL itself is the credential |

## Auth setup

Create an Incoming Webhook at https://api.slack.com/messaging/webhooks. The
URL itself is the credential — anyone with it can post to the destination
channel. Treat as a secret.

## Endpoint

The webhook URL is the endpoint. Slack pinned the URL when the webhook was
created; the channel is fixed per webhook.

## Narrowed input augmentations

Standard chat input (`to` is ignored — channel comes from the webhook URL).
Block Kit and threading via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 400 `no_text` / `invalid_payload` | `invalid_request` |
| 401 / 403 / 404 (revoked webhook) | `auth_failed` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Block Kit message:

```typescript
await sl.send({
  body: 'fallback for clients that don't render blocks',
  _passthrough: {
    body: {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Hello* world' } },
      ],
    },
  },
});
```

## Vendor docs

- API reference: https://api.slack.com/messaging/webhooks
- Block Kit: https://api.slack.com/block-kit
- Errors: https://api.slack.com/messaging/webhooks#handling_errors
