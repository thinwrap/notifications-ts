---
providerId: postmark
channel: email
auth:
  method: api-key-header
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://api.postmarkapp.com/email
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
notes_passthrough: |
  Postmark API uses PascalCase top-level keys. Forward fields like `TemplateId`,
  `TemplateModel`, `Metadata`, or `MessageStream` via `_passthrough.body`.
attachments_supported: true
templates_supported: true
novuProviderId: postmark
tier: 1
---

# Postmark Email Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'postmark'`.

## Configuration

```typescript
const pm = new Email('postmark', {
  serverToken: process.env.POSTMARK_TOKEN!,
  from: 'noreply@example.com',
  senderName: 'Acme',
  messageStream: 'outbound',           // optional default stream
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `serverToken` | `string` | yes | Sent in `X-Postmark-Server-Token` header |
| `from` | `string` | yes | Default sender |
| `senderName` | `string` | no | Composed as `Name <addr>` |
| `messageStream` | `string` | no | e.g., `outbound`, `broadcasts` — applied unless overridden via `_passthrough.body.MessageStream` |

## Auth setup

Get a server-level token from the Postmark account ("Servers → API tokens").
Sent in the `X-Postmark-Server-Token` header. Static.

## Endpoint

`POST https://api.postmarkapp.com/email` (or `/email/withTemplate` for
template sends via passthrough).

## Narrowed input augmentations

Standard email input applies. Postmark templates and message-stream switching
via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 422 ErrorCode 10 | (auth) | `auth_failed` |
| 422 ErrorCode 300 / 406 | invalid email | `invalid_recipient` |
| 422 (other ErrorCode) | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Template send + idempotency:

```typescript
await pm.send({
  to: 'user@example.com',
  subject: 'unused for template send',
  html: '<p>fallback</p>',
  _passthrough: {
    body: {
      TemplateId: 1234567,
      TemplateModel: { name: 'Alice' },
      Metadata: { orderId: '12345' },
    },
  },
});
```

## Vendor docs

- API reference: https://postmarkapp.com/developer/api/email-api
- Error codes: https://postmarkapp.com/developer/api/overview#error-codes
- Rate limits: https://postmarkapp.com/developer/api/overview#rate-limiting
