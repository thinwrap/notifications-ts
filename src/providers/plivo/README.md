# Plivo SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'plivo'`.

## Configuration

```typescript
const pl = new Sms('plivo', {
  authId: process.env.PLIVO_ID!,
  authToken: process.env.PLIVO_TOKEN!,
  from: '+14155550100',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `authId` | `string` | yes | Basic-auth username; also in URL path |
| `authToken` | `string` | yes | Basic-auth password |
| `from` | `string` | no | E.164 or short code |

## Auth setup

`Authorization: Basic base64(<authId>:<authToken>)`. Static.

## Endpoint

`POST https://api.plivo.com/v1/Account/<authId>/Message/` — JSON body.

## Narrowed input augmentations

Standard SMS input. Delivery callbacks via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 | invalid number | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await pl.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: { body: { url: 'https://app.example.com/plivo/callback', method: 'POST' } },
});
```

## Vendor docs

- API reference: https://www.plivo.com/docs/sms/api/message
- Errors: https://www.plivo.com/docs/sms/api/error-codes
