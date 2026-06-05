---
providerId: line
channel: chat
auth:
  method: bearer
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://api.line.me/v2/bot/message/push
versioning:
  vendorApiVersion: v2
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward LINE Messaging API message objects (Flex Message, Sticker,
  Quick Reply) via `_passthrough.body`.
attachments_supported: false
templates_supported: false
novuProviderId: line
tier: 1
---

# LINE Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'line'`.

## Configuration

```typescript
const ln = new Chat('line', {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `channelAccessToken` | `string` | yes | Long-lived Channel Access Token (Bearer) from LINE Developers Console |

## Auth setup

Generate a long-lived Channel Access Token in LINE Developers Console →
your channel → Messaging API. Sent as `Authorization: Bearer
<channelAccessToken>`. Static.

## Endpoint

`POST https://api.line.me/v2/bot/message/push` — single global endpoint.

## Narrowed input augmentations

Standard chat input (`to` is the LINE user ID, `body` is text). Flex
messages, stickers, quick-replies via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 invalid `to` | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await ln.send({
  to: 'U1234567890abcdef1234567890abcdef',
  body: 'fallback for clients that can't render flex',
  _passthrough: {
    body: {
      messages: [{
        type: 'flex',
        altText: 'Hello',
        contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } },
      }],
    },
  },
});
```

## Vendor docs

- API reference: https://developers.line.biz/en/reference/messaging-api/#send-push-message
- Errors: https://developers.line.biz/en/reference/messaging-api/#error-responses
- Flex Messages: https://developers.line.biz/en/docs/messaging-api/using-flex-messages/
