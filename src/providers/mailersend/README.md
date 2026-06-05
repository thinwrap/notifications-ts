---
providerId: mailersend
channel: email
auth:
  method: bearer
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://api.mailersend.com/v1/email
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward MailerSend fields (e.g., `template_id`, `variables`, `tags`) via
  `_passthrough.body`.
attachments_supported: true
templates_supported: true
novuProviderId: mailersend
tier: 1
---

# MailerSend Email Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'mailersend'`.

## Configuration

```typescript
const ms = new Email('mailersend', {
  apiToken: process.env.MAILERSEND_TOKEN!,
  from: 'noreply@example.com',
  senderName: 'Acme',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiToken` | `string` | yes | Sent as `Authorization: Bearer <apiToken>` |
| `from` | `string` | yes | Default sender |
| `senderName` | `string` | no | Default display name |

## Auth setup

Generate a token at MailerSend → Domains → API tokens. Static.

## Endpoint

`POST https://api.mailersend.com/v1/email` — single global endpoint.

## Narrowed input augmentations

Standard email input applies. Templates, variables, and tags via
`_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 422 | invalid recipient | `invalid_recipient` |
| 422 / 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await ms.send({
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
  _passthrough: {
    body: {
      template_id: 'abcdef',
      variables: [{ email: 'user@example.com', substitutions: [{ var: 'name', value: 'Alice' }] }],
      tags: ['welcome'],
    },
  },
});
```

## Vendor docs

- API reference: https://developers.mailersend.com/api/v1/email.html
- Rate limits: https://developers.mailersend.com/general.html#api-response
