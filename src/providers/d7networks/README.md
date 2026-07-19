# D7 Networks SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'd7networks'`.

## Configuration

```typescript
const d7 = new Sms('d7networks', {
  apiToken: process.env.D7_TOKEN!,
  from: 'BrandName',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiToken` | `string` | yes | Bearer credential |
| `from` | `string` | no | Originator |

## Auth setup

Get an API token at D7 Networks → Settings → API tokens. Static.

## Endpoint

`POST https://api.d7networks.com/messages/v1/send` — single global endpoint.

## Narrowed input augmentations

Standard SMS input. Tags, scheduled send via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 invalid recipient | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await d7.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: { body: { tag: 'welcome', schedule_time: '2026-06-01T10:00:00Z' } },
});
```

## Vendor docs

- API reference: https://app.swaggerhub.com/apis-docs/D7Networks/messages/1.1.0
- Errors: https://d7networks.com/docs/Messages/Error-Codes/
