# Rocket.Chat Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'rocket-chat'`.

## Configuration

```typescript
const rc = new Chat('rocket-chat', {
  webhookUrl: 'https://rocket.example.com/hooks/<id>/<token>',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `webhookUrl` | `string` | yes | Incoming Webhook URL — the URL itself is the credential |

## Auth setup

Create an Incoming Webhook in Rocket.Chat → Administration → Integrations →
New → Incoming. The URL is the credential.

This connector is a breaking-config change from the brownfield (which used
the REST API with `serverUrl` + `authToken` + `userId` + `roomId`). Per
`project_existing_repos_state` the predecessor was never published, so no
migration shim is owed.

## Endpoint

The webhook URL is the endpoint. Each webhook is pinned to a default channel;
can be overridden via `_passthrough.body.channel`.

## Narrowed input augmentations

Standard chat input (`body` is `text`). Channel override, alias, emoji, and
attachments via `_passthrough.body`.

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
await rc.send({
  body: 'Build passed',
  _passthrough: {
    body: {
      channel: '#general',
      alias: 'CI Bot',
      attachments: [{ color: '#36a64f', text: 'Build passed' }],
    },
  },
});
```

## Vendor docs

- API reference: https://docs.rocket.chat/use-rocket.chat/workspace-administration/integrations
