# SendGrid Email Connector

## Quick install

See the [package README](../../../README.md) for installation. The connector
dispatches when `providerId === 'sendgrid'`.

## Configuration

```typescript
import { Email } from '@thinwrap/notifications';

const sg = new Email('sendgrid', {
  apiKey: process.env.SENDGRID_KEY!,
  from: 'noreply@example.com',
  senderName: 'Acme',          // optional display name (sent as `{ email, name }`)
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Bearer credential; typically starts with `SG.` |
| `from` | `string` | yes | Default sender email |
| `senderName` | `string` | no | Default sender display name |
| `fetch` | `typeof fetch` | no | BYO fetch (defaults to `globalThis.fetch`) |

## Auth setup

Generate an API key with at minimum **Mail Send** permission at
https://app.sendgrid.com/settings/api_keys. Sent as
`Authorization: Bearer <apiKey>` on every request. Token is static — no
refresh, no rotation, no token caching.

## Endpoint

`POST https://api.sendgrid.com/v3/mail/send` — single global endpoint, no
regional clusters at the time of this README's `lastVerified` date.

## Narrowed input augmentations

The standard email input applies as-is: `from`, `to`, `cc`, `bcc`, `replyTo`,
`subject`, `text`, `html`, `attachments`, `headers`, `tags`. For SendGrid
template sends and other v3-API-specific fields, use `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 | body match for invalid email | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any; respects `Retry-After`) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Forward SendGrid dynamic-template data:

```typescript
await sg.send({
  to: 'user@example.com',
  subject: 'Welcome',
  html: '<p>fallback</p>',
  _passthrough: {
    body: {
      template_id: 'd-xxxxxxxxxxxxxxxx',
      personalizations: [{
        to: [{ email: 'user@example.com' }],
        dynamic_template_data: { name: 'Alice', orderId: '12345' },
      }],
    },
  },
});
```

Add custom categories or schedule-send:

```typescript
_passthrough: {
  body: {
    categories: ['welcome-email', 'cohort-2026q1'],
    send_at: 1715800000,                // unix timestamp
  },
}
```

## Vendor docs

- API reference: https://docs.sendgrid.com/api-reference/mail-send/mail-send
- Error codes: https://docs.sendgrid.com/api-reference/how-to-use-the-sendgrid-v3-api/responses
- Rate limits: https://docs.sendgrid.com/for-developers/sending-email/api-rate-limits
