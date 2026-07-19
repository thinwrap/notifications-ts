# MessageBird (Bird) SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'messagebird'`.

## Configuration

```typescript
const mb = new Sms('messagebird', {
  accessKey: process.env.MESSAGEBIRD_KEY!,
  from: 'BrandName',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessKey` | `string` | yes | Sent as `Authorization: AccessKey <accessKey>` |
| `from` | `string` | no | Originator (alphanumeric or E.164) |

## Auth setup

Get an Access Key at Bird dashboard → Developers → API access. Static.

## Endpoint

`POST https://rest.messagebird.com/messages` — single global endpoint. The
legacy `rest.messagebird.com` surface remains operational for v1.0; provider
ID stays `messagebird` (no `bird` alias).

## Narrowed input augmentations

Standard SMS input. Reference IDs, scheduling, gateway selection via
`_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 422 invalid number | `invalid_recipient` |
| 422 / 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await mb.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: { body: { reference: 'order-12345', scheduledDatetime: '2026-06-01T10:00:00Z' } },
});
```

## Vendor docs

- API reference: https://developers.messagebird.com/api/sms-messaging/
- Errors: https://developers.messagebird.com/api/#errors
