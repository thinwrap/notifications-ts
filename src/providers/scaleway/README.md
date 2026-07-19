# Scaleway Transactional Email (TEM) Connector

EU-sovereign transactional email. Regions are physically EU-resident
(`fr-par`, `nl-ams`, `pl-waw`).

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'scaleway'`.

## Configuration

```typescript
const scw = new Email('scaleway', {
  secretKey: process.env.SCW_SECRET_KEY!,   // sent in X-Auth-Token header
  projectId: process.env.SCW_PROJECT_ID!,   // required — wire field project_id
  from: 'noreply@example.com',
  senderName: 'Acme',                        // optional → from.name
  region: 'fr-par',                          // optional — default 'fr-par'
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `secretKey` | `string` | yes | Scaleway IAM API secret key, sent in the `X-Auth-Token` header |
| `projectId` | `string` | yes | Written as `project_id` on every send |
| `from` | `string` | yes | Default sender email |
| `senderName` | `string` | no | Composed into `from.name` |
| `region` | `'fr-par' \| 'nl-ams' \| 'pl-waw'` | no | Default `fr-par`; interpolated into the endpoint **path** |

## Auth setup

Generate an API key (Access key + Secret key) under Scaleway IAM. Only the
**secret key** is used here, sent verbatim in the `X-Auth-Token` header. Static.

## Endpoint

`POST https://api.scaleway.com/transactional-email/v1alpha1/regions/{region}/emails`

The region is part of the URL path (not a host swap).

## Wire mapping

| Thinwrap input | Scaleway wire field |
|---|---|
| `from` / `config.from` (+ `senderName`) | `from: { email, name? }` |
| `to` | `to: [{ email }]` |
| `cc` / `bcc` | `cc` / `bcc: [{ email }]` |
| `subject` / `text` / `html` | `subject` / `text` / `html` |
| `config.projectId` | `project_id` |
| `headers` | `additional_headers: [{ key, value }]` |
| `replyTo` | folded into `additional_headers` as `Reply-To` |
| `attachments` | `attachments: [{ name, type, content(base64) }]` |

### Graceful degradation

Per Thinwrap's baseline-coverage discipline, fields with no Scaleway equivalent
at v1.0 are silently dropped (no error, no warning):

- **`tags`** — Scaleway TEM has no tags field; dropped.
- **attachment `contentId`** — no inline-image field; dropped (the attachment
  is still sent as a normal attachment).

Attachments without a `contentType` default to `application/octet-stream`
(Scaleway requires a `type` on every attachment).

## Error mapping

| Vendor HTTP | `providerCode` |
|---|---|
| 401 / 403 | `auth_failed` |
| 400 / 404 / 422 | `invalid_request` |
| 429 | `rate_limited` |
| 5xx | `provider_unavailable` |
| network failure | `provider_unavailable` |
| abort | `invalid_request` |

`Retry-After` is surfaced in `ConnectorError.providerMessage` and on
`cause.retryAfter` (raw) / `cause.retryAfterSeconds` (parsed). There is no
top-level `retryAfterSeconds` field — retry is consumer policy.

## Success mapping

A 2xx response (`{ emails: [{ id, message_id, status: "new" }] }`) maps to
`{ success: true, status: 'queued', providerMessageId: emails[0].message_id }`
— Scaleway accepts for delivery asynchronously, so `'queued'` is vendor-faithful.

## `_passthrough` example

```typescript
await scw.send({
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
  _passthrough: { body: { scheduledAt: '2026-06-03T09:00:00Z' } }, // → scheduled_at
});
```

## Vendor docs

- API reference: https://www.scaleway.com/en/developers/api/transactional-email/
- Send an email: https://www.scaleway.com/en/docs/transactional-email/api-cli/send-emails-with-api/
- IAM API keys: https://www.scaleway.com/en/docs/transactional-email/how-to/generate-api-keys-for-tem-with-iam/
