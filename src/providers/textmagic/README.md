# Textmagic SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'textmagic'`.

## Configuration

```typescript
const tm = new Sms('textmagic', {
  username: process.env.TEXTMAGIC_USER!,
  apiKey: process.env.TEXTMAGIC_KEY!,
  from: 'BrandName',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `username` | `string` | yes | Sent in `X-TM-Username` header |
| `apiKey` | `string` | yes | Sent in `X-TM-Key` header |
| `from` | `string` | no | Alphanumeric or E.164 |

## Auth setup

Two-header pair `X-TM-Username` + `X-TM-Key` (distinct from every other
wrapped SMS provider's single-header / Basic / Bearer scheme). Get an API
key at Textmagic → Account → API tokens.

## Endpoint

`POST https://rest.textmagic.com/api/v2/messages` — single global endpoint.

## Narrowed input augmentations

Standard SMS input. Scheduling, cut-extra, parts-count via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 invalid number | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await tm.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: { body: { sendingTime: 1717238400 } },
});
```

## Vendor docs

- API reference: https://docs.textmagic.com/#operation/sendMessage
- Auth: https://docs.textmagic.com/#section/Authentication
