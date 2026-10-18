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
| `senderName` | `string` | no | Composed into an RFC 5322 mailbox: quoted when it has specials (`"Acme, Inc." <a@b.c>`), RFC 2047-encoded when non-ASCII |
| `region` | `'us' \| 'eu'` | no | `us` → `api.mailgun.net`; `eu` → `api.eu.mailgun.net` |
| `username` | `string` | no | Override Basic-auth username (default `api`) |
| `baseUrl` | `string` | no | Escape hatch for self-hosted; must be `https://` (the Basic credentials go to it) — anything else → `invalid_request` |

## Auth setup

Get a Sending API key at https://app.mailgun.com/app/account/security/api_keys.
The connector sends `Authorization: Basic base64('api:<apiKey>')`. Static.

## Endpoint

Region-derived:
- `us` (default): `https://api.mailgun.net/v3/<domain>/messages`
- `eu`: `https://api.eu.mailgun.net/v3/<domain>/messages`

## Narrowed input augmentations

Standard email input applies. Mailgun-specific tagging / tracking flags via
`_passthrough.body`. In the form and multipart bodies alike, an array value
becomes repeated fields (`o:tag=a&o:tag=b`) and a plain object becomes compact
JSON (`t:variables`, which Mailgun takes as "A valid JSON-encoded dictionary").

`headers` become `h:<Name>` fields and `replyTo` becomes `h:Reply-To`. Header
names are case-insensitive, so only one field per name is sent: among
`headers` the last case-variant wins, and the typed `replyTo` wins over a
`Reply-To` in `headers`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 402 / 403 | (any) | `auth_failed` |
| 400 | invalid address | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `provider_unavailable` |

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

- API reference: https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages
- Regions: https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview
- Rate limits: https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview
