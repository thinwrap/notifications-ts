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

Standard email input applies; `replyTo` is sent as the `reply_to` object
`{ email }` and `headers` as `[{ name, value }]`. Templates, variables, and
tags via `_passthrough.body`.

## Response handling

MailerSend answers `202 Accepted` with an empty body and the id in
`X-Message-Id`. When recipients are suppressed the 202 carries a `warnings`
body instead:

- `SOME_SUPPRESSED` — sent to the remaining recipients; success, with the
  vendor body (`message`, `warnings`) kept on `raw` next to `messageId`.
- `ALL_SUPPRESSED` — nothing is sent and no `X-Message-Id` is returned;
  surfaced as `invalid_recipient` with the body on `cause.raw`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 422 | invalid recipient | `invalid_recipient` |
| 202 | `warnings[].type === 'ALL_SUPPRESSED'` | `invalid_recipient` |
| 422 / 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `provider_unavailable` |

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
