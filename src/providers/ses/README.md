# Amazon SES Email Connector

## Quick install

See the [package README](../../../README.md) for installation. Dispatches when
`providerId === 'ses'`.

## Configuration

```typescript
import { Email } from '@thinwrap/notifications';

const ses = new Email('ses', {
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN, // optional (STS)
  from: 'noreply@example.com',
  senderName: 'Acme',
  configurationSetName: 'transactional',       // optional
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `region` | `string` | yes | AWS region (e.g., `us-east-1`). Endpoint is computed; a value that is not an AWS region name → `invalid_request` before signing. |
| `accessKeyId` | `string` | yes | IAM access key |
| `secretAccessKey` | `string` | yes | IAM secret |
| `sessionToken` | `string` | no | STS session token; signed and sent as `X-Amz-Security-Token` when present |
| `from` | `string` | yes | Default sender |
| `senderName` | `string` | no | Default display name |
| `configurationSetName` | `string` | no | Default SES configuration set |

## Auth setup

AWS Signature V4 — the connector hand-rolls Sig V4 against `node:crypto`
(no runtime dependency). Static credentials only (no in-wrapper refresh);
use STS elsewhere and pass the resulting `sessionToken` per-instance.

## Endpoint

Region-derived: `https://email.<region>.amazonaws.com/v2/email/outbound-emails`.
No global endpoint.

## Narrowed input augmentations

Standard email input applies. Everything is sent as SES v2 `Content.Simple`:

- **Attachments** go in `Content.Simple.Attachments` (`FileName`,
  base64 `RawContent`, `ContentType`, and `ContentDisposition: INLINE` +
  `ContentId` when `contentId` is set, else `ATTACHMENT`). SES builds the MIME
  message; the connector does not hand-build raw MIME.
- **`headers`** go in `Content.Simple.Headers`. SES's rules are enforced before
  sending, as `invalid_request`: at most 15 headers; names printable ASCII
  without `:`; values printable ASCII, 1–995 characters, name + value ≤ 996
  (a non-ASCII value is sent as RFC 2047 encoded-words, which are ASCII); a
  CR, LF or NUL in a value is rejected rather than rewritten. SES
  rejects these as custom headers, so the connector does too, naming the typed
  field to use instead: `BCC`, `CC`, `Content-Disposition`, `Content-Type`,
  `Date`, `From`, `Message-ID`, `MIME-Version`, `Reply-To`, `Return-Path`,
  `Subject`, `To`.
- **`senderName`** is formatted into `FromEmailAddress` as an RFC 5322
  mailbox (a `from` already written as `Name <addr>` is parsed, and its own
  name wins over `senderName`): quoted when it contains specials (`"Acme, Inc." <a@b.c>`), and as
  RFC 2047 encoded-words when it is non-ASCII, which SES requires for a
  Unicode "friendly from" name.

SES-narrowed fields (`SesEmailSendInput`): `configurationSetName`, `sourceArn`
(→ `FromEmailAddressIdentityArn`), `feedbackForwardingEmailAddress`
(→ `FeedbackForwardingEmailAddress`, where SES sends bounce and complaint
notifications; SES v2 has no `ReturnPath`, so the deprecated `returnPath` alias
maps here too) and `tags` (→ `EmailTags`). Tag names and values may contain only
ASCII letters, digits, `_` and `-` (max 256); anything else is rejected with
`invalid_request`. Other SES v2 fields (e.g. `ListManagementOptions`,
`EndpointId`) go through `_passthrough.body`.

## Error mapping

The error code is read like the AWS SDKs read it: the `x-amzn-ErrorType`
header, then body `code`/`Code`, then `__type`, trimmed to its bare name.

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 | `SendingPausedException`, `AccountSuspendedException` | `auth_failed` |
| 400 | `MessageRejected` (invalid content), `MailFromDomainNotVerifiedException`, `LimitExceededException`, `BadRequestException`, other | `invalid_request` |
| 404 | `NotFoundException` | `invalid_request` |
| 429 / `TooManyRequestsException` / `ThrottlingException` | — | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `provider_unavailable` |

## `_passthrough` examples

Override the SES configuration set per-call:

```typescript
await ses.send({
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
  _passthrough: {
    body: { ConfigurationSetName: 'marketing', EmailTags: [{ Name: 'env', Value: 'prod' }] },
  },
});
```

## Vendor docs

- API reference: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
- Regional endpoints: https://docs.aws.amazon.com/general/latest/gr/ses.html
- Headers SES sets itself: https://docs.aws.amazon.com/ses/latest/dg/header-fields.html
- AWS SigV4: https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html
