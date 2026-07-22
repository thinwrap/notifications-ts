# Vonage (Nexmo) SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'vonage'` or its Novu-compatible alias `'nexmo'`. Both
narrow to the same `VonageConfig`.

## Configuration

```typescript
const v = new Sms('vonage', {
  apiKey: process.env.VONAGE_KEY!,
  apiSecret: process.env.VONAGE_SECRET!,
  from: '+14155550100',                // optional default sender
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Sent as form field `api_key` (not header) |
| `apiSecret` | `string` | yes | Sent as form field `api_secret` |
| `from` | `string` | no | E.164 or alphanumeric; per-call overridable |

## Auth setup

Get credentials at Vonage Dashboard → Settings. Both `apiKey` and `apiSecret`
are sent in the POST body, not headers.

## Endpoint

`POST https://rest.nexmo.com/sms/json` — single global endpoint.

## Narrowed input augmentations

Standard SMS input applies (`to`, `from`, `body`). Vendor-specific
features (delivery callbacks, message class) via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 200 with `status: '4'` (invalid creds) | `auth_failed` |
| 200 with `status: '6'/'7'` (invalid number) | `invalid_recipient` |
| 200 with other `status != '0'` | `invalid_request` |
| 429 / `status: '1'` (throttled) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await v.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: {
    body: { 'client-ref': 'order-12345', 'message-class': '1' },
  },
});
```

## Vendor docs

- API reference: https://developer.vonage.com/en/api/sms
- Error codes: https://developer.vonage.com/en/api/sms#errors
