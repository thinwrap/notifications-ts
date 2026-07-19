# Microsoft Teams Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'ms-teams'`.

## Configuration

```typescript
const tm = new Chat('ms-teams', {
  webhookUrl: 'https://outlook.office.com/webhook/...',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `webhookUrl` | `string` | yes | Teams channel Incoming Webhook — the URL itself is the credential |

## Auth setup

Create an Incoming Webhook in Teams → channel → Connectors → Incoming
Webhook. The URL is the credential.

## Endpoint

The webhook URL is the endpoint. Each webhook is pinned to a channel.

## Narrowed input augmentations

Standard chat input (`body` is `text`). Adaptive Cards or legacy
MessageCard payloads via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 / 404 (webhook removed) | `auth_failed` |
| 400 malformed card | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Adaptive Card:

```typescript
await tm.send({
  body: 'Build passed',
  _passthrough: {
    body: {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [{ type: 'TextBlock', text: 'Build passed', weight: 'Bolder' }],
        },
      }],
    },
  },
});
```

## Vendor docs

- API reference: https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
- Adaptive Cards: https://adaptivecards.io/explorer/
