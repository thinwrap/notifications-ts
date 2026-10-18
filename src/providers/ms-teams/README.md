# Microsoft Teams Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'ms-teams'`.

## Configuration

```typescript
const tm = new Chat('ms-teams', {
  webhookUrl: 'https://prod-00.westus.logic.azure.com:443/workflows/.../triggers/manual/paths/invoke?...',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `webhookUrl` | `string` | yes | Teams Workflows webhook URL (or a legacy connector Incoming Webhook URL) — the URL itself is the credential |

## Auth setup

Create a Workflows webhook: a workflow (Teams → Workflows, or Power
Automate) whose trigger is "When a Teams webhook request is received" and
which posts the received Adaptive Card to the channel. Copy the URL the
trigger generates — the URL is the credential.

Legacy Office 365 connector Incoming Webhooks (`*.webhook.office.com`,
`outlook.office.com`) are still accepted; Microsoft is retiring them in favor
of Workflows.

## Endpoint

The webhook URL is the endpoint. Each webhook is pinned to a channel.

Success detection depends on the webhook generation:

- `202 Accepted` is success whatever the body — a Workflows trigger answers
  202 with no body when the flow has no Response action.
- A 2xx body containing `HTTP error NNN` is a failure mapped from `NNN`
  (legacy connectors report throttling this way on HTTP 200).
- On a legacy connector host any 2xx body other than `1` is a failure
  (`502` → `provider_unavailable`); on a Workflows URL any other 2xx is
  success.

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
| network failure | — | `provider_unavailable` |

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
