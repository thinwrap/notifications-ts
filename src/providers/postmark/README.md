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

`POST https://api.postmarkapp.com/email`, or `POST
https://api.postmarkapp.com/email/withTemplate` when the final merged body
carries `TemplateId` or `TemplateAlias` (from `_passthrough.body`, either
casing). On the template endpoint the template produces the subject and
bodies from `TemplateModel` (sent as `{}` when you give none, since Postmark
requires it), so the connector drops `Subject`, `HtmlBody` and `TextBody`; `From`, `To`, `Cc`, `Bcc`, `ReplyTo`, `Tag`, `Headers`,
`Attachments`, `Metadata`, `MessageStream` and tracking flags are sent as
usual. Both `send()` and `sendMessage()` route this way.

## Narrowed input augmentations

Standard email input applies. Message-stream switching (`MessageStream`),
`Metadata`, `TrackOpens` and other `/email` fields via `_passthrough.body`.
`senderName` + `from` become one mailbox string, quoted when the name has
specials (`"Joe Sender, Jr." <a@b.c>`) and RFC 2047-encoded when non-ASCII.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 422 | `ErrorCode` 10, 412 (pending account), 413 (not approved), 422 (invalid server/account), 1480 (IP not authorized) | `auth_failed` |
| 422 | `ErrorCode` 406 (inactive recipient); 300 when the message is about a `'To'`/`'Cc'`/`'Bcc'` address | `invalid_recipient` |
| 422 | `ErrorCode` 300 (other send validation: zero recipients, a bad From/Reply-To, limits), 402, 403, 410, 411 (attachment type), 1101, 1235, 1236, other | `invalid_request` |
| 400 / 404 / 413 / 415 / other 4xx | (any) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `provider_unavailable` |

## `_passthrough` examples

Template send (routes to `/email/withTemplate`; `subject` is required by the
input type but not sent):

```typescript
await pm.send({
  to: 'user@example.com',
  subject: 'unused for template sends',
  _passthrough: {
    body: {
      TemplateAlias: 'welcome',          // or TemplateId: 1234567
      TemplateModel: { name: 'Alice' },
    },
  },
});
```

Message stream + metadata:

```typescript
await pm.send({
  to: 'user@example.com',
  subject: 'Your receipt',
  html: '<p>Thanks!</p>',
  _passthrough: {
    body: {
      MessageStream: 'outbound',
      Metadata: { orderId: '12345' },
    },
  },
});
```

## Vendor docs

- API reference: https://postmarkapp.com/developer/api/email-api
- Templates API: https://postmarkapp.com/developer/api/templates-api
- Error codes: https://postmarkapp.com/developer/api/overview#error-codes
- Rate limits: https://postmarkapp.com/developer/api/overview#rate-limiting
