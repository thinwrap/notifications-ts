# Telnyx SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'telnyx'`.

## Configuration

```typescript
const tx = new Sms('telnyx', {
  apiKey: process.env.TELNYX_KEY!,
  from: '+14155550100',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Bearer credential (starts with `KEY…`) |
| `from` | `string` | no | E.164, short code, or alphanumeric sender ID |

## Auth setup

Get an API key at Telnyx → Auth → API V2 keys. Static.

## Endpoint

`POST https://api.telnyx.com/v2/messages` — single global endpoint.

## Narrowed input augmentations

Standard SMS input. Messaging profile, MMS media URLs, delivery webhook via
`_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 422 with code `40300`/`40005` (invalid number) | `invalid_recipient` |
| 422 / 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await tx.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: {
    body: { messaging_profile_id: 'abc-123', webhook_url: 'https://app.example.com/dr' },
  },
});
```

## Vendor docs

- API reference: https://developers.telnyx.com/docs/messaging/messages/send-message
- Errors: https://developers.telnyx.com/docs/messaging/messages/error-codes/index
