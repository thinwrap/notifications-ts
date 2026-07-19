# Discord Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'discord'`.

## Configuration

```typescript
const dc = new Chat('discord', {
  webhookUrl: 'https://discord.com/api/webhooks/<id>/<token>',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `webhookUrl` | `string` | yes | Discord channel webhook — the URL itself is the credential |

## Auth setup

Create a webhook in Discord → Channel Settings → Integrations → Webhooks. The
URL is the credential.

## Endpoint

The webhook URL is the endpoint. Each webhook is pinned to a channel.

## Narrowed input augmentations

Standard chat input (`body` is the message content). Embeds, username
override, avatar override via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 404 (revoked webhook) | `auth_failed` |
| 400 invalid `content` / embed | `invalid_request` |
| 429 with `retry_after` | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Embed message:

```typescript
await dc.send({
  body: 'Headline',
  _passthrough: {
    body: {
      embeds: [{ title: 'Build passed', description: 'Tag v1.0.0', color: 0x57f287 }],
      username: 'CI Bot',
    },
  },
});
```

## Vendor docs

- API reference: https://discord.com/developers/docs/resources/webhook#execute-webhook
- Rate limits: https://discord.com/developers/docs/topics/rate-limits
