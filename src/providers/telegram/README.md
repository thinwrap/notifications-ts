# Telegram Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'telegram'`.

## Configuration

```typescript
const tg = new Chat('telegram', {
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `botToken` | `string` | yes | From @BotFather; embedded in URL path |

## Auth setup

Create a bot via @BotFather and grab its token. The token is the credential —
embedded in the request URL path. Static. The `to` field on `ChatSendInput`
carries the chat ID (numeric or `@channel`).

## Endpoint

`POST https://api.telegram.org/bot<botToken>/sendMessage` — single global endpoint.

## Narrowed input augmentations

Standard chat input (`to`, `body`). Telegram-specific (`parse_mode`,
`reply_markup`, `entities`) via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 | (any) | `auth_failed` |
| 400 `chat not found` | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 / `retry_after` | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await tg.send({
  to: '@my_channel',
  body: '*Hello* in MarkdownV2',
  _passthrough: { body: { parse_mode: 'MarkdownV2', disable_notification: true } },
});
```

## Vendor docs

- API reference: https://core.telegram.org/bots/api#sendmessage
- Errors: https://core.telegram.org/api/errors
