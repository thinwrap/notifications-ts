---
providerId: sinch
channel: sms
auth:
  method: bearer
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://us.sms.api.sinch.com
versioning:
  vendorApiVersion: xms-v1
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward Sinch xms batch fields (`delivery_report`, `callback_url`,
  `send_at`, etc.) via `_passthrough.body`.
regions:
  - us
  - eu
attachments_supported: false
templates_supported: false
novuProviderId: null
tier: 2
---

# Sinch SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'sinch'`.

## Configuration

```typescript
const sn = new Sms('sinch', {
  servicePlanId: process.env.SINCH_PLAN_ID!,
  apiToken: process.env.SINCH_TOKEN!,
  from: '+14155550100',
  region: 'us',                        // 'us' (default) or 'eu'
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `servicePlanId` | `string` | yes | URL path parameter |
| `apiToken` | `string` | yes | Bearer credential |
| `from` | `string` | no | Per-call overridable |
| `region` | `'us' \| 'eu'` | no | Sinch cluster |

## Auth setup

Service Plan ID + API Token from Sinch dashboard → Service plans. Static.

## Endpoint

Region-derived:
- `us` (default): `https://us.sms.api.sinch.com/xms/v1/<servicePlanId>/batches`
- `eu`: `https://eu.sms.api.sinch.com/xms/v1/<servicePlanId>/batches`

## Narrowed input augmentations

Standard SMS input. Delivery report URLs, scheduled send via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 `invalid_recipient` | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await sn.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: {
    body: { delivery_report: 'full', callback_url: 'https://app.example.com/sinch/dr' },
  },
});
```

## Vendor docs

- API reference: https://developers.sinch.com/docs/sms/api-reference/sms/tag/Batches
- EU endpoint: https://developers.sinch.com/docs/sms/getting-started/regions
