---
providerId: ses
channel: email
auth:
  method: aws-sigv4
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://email.us-east-1.amazonaws.com/v2/email/outbound-emails
versioning:
  vendorApiVersion: v2
  lastVerified: 2026-05-17
notes_passthrough: |
  Forward SES v2 fields (e.g., `ConfigurationSetName`, `Tags`,
  `FromEmailAddressIdentityArn`) via `_passthrough.body`. Keys are forwarded
  verbatim — SES expects PascalCase top-level keys.
regions:
  - us-east-1
  - us-east-2
  - us-west-1
  - us-west-2
  - eu-west-1
  - eu-central-1
  - ap-northeast-1
  - ap-southeast-1
  - ap-southeast-2
attachments_supported: true
templates_supported: true
novuProviderId: ses
tier: 1
---

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
| `region` | `string` | yes | AWS region (e.g., `us-east-1`). Endpoint is computed. |
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

Standard email input applies. SES v2-specific fields (e.g., template ARNs,
configuration overrides) go through `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 | invalid email body match | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 / `ThrottlingException` | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Override the SES configuration set per-call:

```typescript
await ses.send({
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
  _passthrough: {
    body: { ConfigurationSetName: 'marketing', Tags: [{ Name: 'env', Value: 'prod' }] },
  },
});
```

## Vendor docs

- API reference: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
- Regional endpoints: https://docs.aws.amazon.com/general/latest/gr/ses.html
- AWS SigV4: https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html
