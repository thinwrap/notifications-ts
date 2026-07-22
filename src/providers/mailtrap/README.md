# Mailtrap Email Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'mailtrap'`.

## Configuration

```typescript
const mt = new Email('mailtrap', {
  apiToken: process.env.MAILTRAP_TOKEN!,
  mode: 'production',                  // REQUIRED — 'production' | 'sandbox'
  inboxId: undefined,                  // REQUIRED when mode === 'sandbox'
  from: 'noreply@example.com',
  senderName: 'Acme',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiToken` | `string` | yes | Bearer credential |
| `mode` | `'sandbox' \| 'production'` | yes | No default — picked explicitly to avoid asymmetric failure |
| `inboxId` | `string` | conditional | Required when `mode === 'sandbox'`; forbidden in production. Validated at construction. |
| `from` | `string` | yes | Default sender |
| `senderName` | `string` | no | Default display name |

## Auth setup

Get an API token at Mailtrap → Sending Domains → API tokens. Static.

## Endpoint

Mode-derived:
- `production`: `https://send.api.mailtrap.io/api/send`
- `sandbox`: `https://sandbox.api.mailtrap.io/api/send/<inboxId>`

## Narrowed input augmentations

Standard email input applies. Template sends via `_passthrough.body`.

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
await mt.send({
  to: 'user@example.com',
  subject: 'unused',
  html: '<p>fallback</p>',
  _passthrough: {
    body: {
      template_uuid: 'abcdef-123',
      template_variables: { name: 'Alice' },
    },
  },
});
```

## Vendor docs

- API reference: https://docs.mailtrap.io/developers
- Sandbox guide: https://docs.mailtrap.io/email-sandbox/setup/sandbox-api-integration
