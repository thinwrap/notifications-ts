---
providerId: resend
channel: email
auth:
  method: bearer
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://api.resend.com/emails
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward Resend fields (e.g., `react`, `scheduled_at`, `headers`) via
  `_passthrough.body`. Use `_passthrough.headers` for `Idempotency-Key`.
attachments_supported: true
templates_supported: false
novuProviderId: resend
tier: 1
---

# Resend Email Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'resend'`.

## Configuration

```typescript
const r = new Email('resend', {
  apiKey: process.env.RESEND_KEY!,
  from: 'noreply@example.com',
  senderName: 'Acme',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Bearer credential (starts with `re_`) |
| `from` | `string` | yes | Default sender email |
| `senderName` | `string` | no | Composed alongside `from` |
| `fetch` | `typeof fetch` | no | BYO fetch |

## Auth setup

Create an API key at https://resend.com/api-keys. Sent as
`Authorization: Bearer <apiKey>`. Static; no refresh.

## Endpoint

`POST https://api.resend.com/emails` — single global endpoint.

## Narrowed input augmentations

Standard email input applies. Resend templating is typically done via
`react-email` rendered at the consumer side and sent as `html`; for
`scheduled_at` and similar fields, use `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 422 | invalid `to` | `invalid_recipient` |
| 400 / 422 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Send-at scheduling and idempotency:

```typescript
await r.send({
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
  _passthrough: {
    body: { scheduled_at: '2026-06-01T15:00:00.000Z' },
    headers: { 'Idempotency-Key': 'order-12345' },
  },
});
```

## Vendor docs

- API reference: https://resend.com/docs/api-reference/emails/send-email
- Idempotency: https://resend.com/docs/api-reference/idempotency
- Rate limits: https://resend.com/docs/api-reference/rate-limit
