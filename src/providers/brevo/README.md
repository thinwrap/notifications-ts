# Brevo Email Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'brevo'`.

## Configuration

```typescript
const bv = new Email('brevo', {
  apiKey: process.env.BREVO_KEY!,
  from: 'noreply@example.com',
  senderName: 'Acme',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Sent in the `api-key` header (NOT `Authorization: Bearer …`) |
| `from` | `string` | yes | Default sender |
| `senderName` | `string` | no | Composed alongside `from` as `sender: { name, email }` |

## Auth setup

Get an API key at Brevo → SMTP & API → API keys. Static.

## Endpoint

`POST https://api.brevo.com/v3/smtp/email` — single global endpoint.

## Narrowed input augmentations

Standard email input applies. Brevo template sends and transactional template
params via `_passthrough.body`.

## Outlier translation — attachment `contentId`

Brevo's API does **not** support per-attachment `contentId`. The connector
throws `ConnectorError({ providerCode: 'invalid_request' })` when an attachment
includes a `contentId` field. Per the baseline-coverage rule, this
is an architectural-outlier exception — translation is local to the connector,
not propagated to the facade.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 | invalid email | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await bv.send({
  to: 'user@example.com',
  subject: 'unused for template',
  html: '<p>fallback</p>',
  _passthrough: {
    body: { templateId: 9, params: { name: 'Alice' }, tags: ['welcome'] },
  },
});
```

## Vendor docs

- API reference: https://developers.brevo.com/reference/send-transac-email
- Templates: https://developers.brevo.com/docs/send-a-transactional-email
- Rate limits: https://developers.brevo.com/docs/api-limits
