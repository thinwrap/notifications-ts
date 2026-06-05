---
providerId: sparkpost
channel: email
auth:
  method: api-key-header
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://api.sparkpost.com/api/v1/transmissions
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
notes_passthrough: |
  SparkPost transmissions accept rich top-level fields (`options`,
  `metadata`, `substitution_data`). Forward via `_passthrough.body`.
regions:
  - us
  - eu
attachments_supported: true
templates_supported: true
novuProviderId: sparkpost
tier: 1
---

# SparkPost Email Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'sparkpost'`.

## Configuration

```typescript
const sp = new Email('sparkpost', {
  apiKey: process.env.SPARKPOST_KEY!,
  from: 'noreply@example.com',
  senderName: 'Acme',
  region: 'us',                        // 'us' (default) or 'eu'
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Sent verbatim in `Authorization` (no `Bearer` prefix) |
| `from` | `string` | yes | Default sender |
| `senderName` | `string` | no | Composed alongside `from` |
| `region` | `'us' \| 'eu'` | no | `us` → `api.sparkpost.com`; `eu` → `api.eu.sparkpost.com` |

## Auth setup

Get an API key at SparkPost → Account → API keys, grant `Transmissions: Read/Write`.
Sent verbatim in `Authorization` (no `Bearer` prefix). Static.

## Endpoint

Region-derived:
- `us` (default): `https://api.sparkpost.com/api/v1/transmissions`
- `eu`: `https://api.eu.sparkpost.com/api/v1/transmissions`

## Outlier translation — CC / BCC

SparkPost models CC/BCC differently from every other email vendor: there is no
top-level `cc` / `bcc` field. Instead, the connector translates inputs into:
- `recipients[].header_to` (per recipient list) — names the visible `To`.
- `content.headers.CC` — added when `cc` is non-empty.

This translation lives in the connector and is invisible at the facade level.
Per the baseline-coverage rule, this is an architectural-outlier
exception kept local.

## Narrowed input augmentations

Standard email input applies. Substitution data, options, metadata via
`_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 | invalid email body match | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 420 / 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await sp.send({
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
  _passthrough: {
    body: {
      substitution_data: { name: 'Alice' },
      options: { transactional: true, sandbox: false },
      metadata: { orderId: '12345' },
    },
  },
});
```

## Vendor docs

- API reference: https://developers.sparkpost.com/api/transmissions/
- EU endpoint: https://www.sparkpost.com/docs/getting-started/getting-started-sparkpost/#eu-account-information
- Rate limits: https://developers.sparkpost.com/api/index.html#header-rate-limiting
