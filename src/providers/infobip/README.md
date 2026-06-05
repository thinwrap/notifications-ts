---
providerId: infobip
channel: sms
auth:
  method: api-key-header
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://example.api.infobip.com/sms/3/messages/text/advanced
versioning:
  vendorApiVersion: v3
  lastVerified: 2026-05-17
notes_passthrough: |
  Infobip uses camelCase JSON. Forward fields (`flash`, `intermediateReport`,
  `notifyUrl`, etc.) via `_passthrough.body`.
attachments_supported: false
templates_supported: false
novuProviderId: 'infobip-sms'
tier: 2
---

# Infobip SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'infobip'`.

## Configuration

```typescript
const ib = new Sms('infobip', {
  baseUrl: 'xyz123.api.infobip.com',   // REQUIRED — per-account subdomain
  apiKey: process.env.INFOBIP_KEY!,
  from: 'BrandName',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `baseUrl` | `string` | yes | Per-account subdomain — no scheme, no trailing slash |
| `apiKey` | `string` | yes | Sent as `Authorization: App <apiKey>` |
| `from` | `string` | no | Alphanumeric or E.164 |

## Auth setup

Custom `Authorization: App <apiKey>` scheme. The `baseUrl` is per-account and
provisioned at sign-up — there is no shared global endpoint.

## Endpoint

`POST https://<baseUrl>/sms/3/messages/text/advanced` — `baseUrl` is per
account.

## Narrowed input augmentations

Standard SMS input. Delivery reporting, flash messages, scheduling via
`_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 with destination error | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await ib.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: {
    body: { notifyUrl: 'https://app.example.com/ib/dr', intermediateReport: true },
  },
});
```

## Vendor docs

- API reference: https://www.infobip.com/docs/api/channels/sms/sms-api/send-sms-message
- Account base URL: https://www.infobip.com/docs/essentials/base-url
