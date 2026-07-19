# Mailgun Email Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'mailgun'`.

## Configuration

```typescript
const mg = new Email('mailgun', {
  apiKey: process.env.MAILGUN_KEY!,
  domain: 'mg.example.com',         // forms /v3/<domain>/messages path
  from: 'noreply@example.com',
  region: 'us',                      // 'us' (default) or 'eu'
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Basic-auth password (username is `api`) |
| `domain` | `string` | yes | Mailgun sending domain |
| `from` | `string` | yes | Default sender |
| `senderName` | `string` | no | Composed as `"<senderName> <from>"` |
| `region` | `'us' \| 'eu'` | no | `us` → `api.mailgun.net`; `eu` → `api.eu.mailgun.net` |
| `username` | `string` | no | Override Basic-auth username (default `api`) |
| `baseUrl` | `string` | no | Escape hatch for self-hosted |

## Auth setup

Get a Sending API key at https://app.mailgun.com/app/account/security/api_keys.
The connector sends `Authorization: Basic base64('api:<apiKey>')`. Static.

## Endpoint

Region-derived:
- `us` (default): `https://api.mailgun.net/v3/<domain>/messages`
- `eu`: `https://api.eu.mailgun.net/v3/<domain>/messages`

## Narrowed input augmentations

Standard email input applies. Mailgun-specific tagging / tracking flags via
`_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 | invalid address | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Tagging and tracking:

```typescript
await mg.send({
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
  _passthrough: {
    body: {
      'o:tag': ['welcome', 'cohort-q1'],
      'o:tracking': 'yes',
      'h:X-Mailgun-Variables': JSON.stringify({ orderId: '12345' }),
    },
  },
});
```

## Vendor docs

- API reference: https://documentation.mailgun.com/en/latest/api-sending.html
- Regions: https://documentation.mailgun.com/en/latest/api-intro.html#mailgun-regions
- Rate limits: https://documentation.mailgun.com/en/latest/api-rate-limit.html
