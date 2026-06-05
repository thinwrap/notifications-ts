---
providerId: sns
channel: sms
auth:
  method: aws-sigv4
  tokenLifecycle: static
  tokenCacheHookSupported: false
endpoint:
  default: https://sns.us-east-1.amazonaws.com
versioning:
  vendorApiVersion: 2010-03-31
  lastVerified: 2026-05-17
notes_passthrough: |
  SNS uses form-encoded `Publish` action. Forward attributes like
  `AWS.SNS.SMS.SMSType`, `AWS.SNS.SMS.SenderID` via `_passthrough.body` (sent
  as `MessageAttributes.entry.N.*` keys).
regions:
  - us-east-1
  - us-west-2
  - eu-west-1
  - eu-central-1
  - ap-southeast-1
  - ap-southeast-2
  - ap-northeast-1
attachments_supported: false
templates_supported: false
novuProviderId: sns
tier: 2
---

# Amazon SNS SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'sns'`.

## Configuration

```typescript
const sns = new Sms('sns', {
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN, // optional (STS)
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `region` | `SnsRegion` | yes | SMS-eligible AWS region — no environment inference |
| `accessKeyId` | `string` | yes | IAM access key |
| `secretAccessKey` | `string` | yes | IAM secret |
| `sessionToken` | `string` | no | STS token, signed and sent as `X-Amz-Security-Token` when present |

## Auth setup

AWS Signature V4, hand-rolled against `node:crypto` (no runtime dependency).
Region is required (SNS SMS is only available in select regions).

## Endpoint

Region-derived: `https://sns.<region>.amazonaws.com/`. Form-encoded `Publish`
action body.

## Narrowed input augmentations

Standard SMS input. SenderID, transactional/promotional category, max price
attributes via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 403 (`InvalidClientTokenId`) | `auth_failed` |
| 400 `InvalidParameter` for `PhoneNumber` | `invalid_recipient` |
| 400 (other) | `invalid_request` |
| 429 / `Throttling` | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await sns.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: {
    body: {
      'MessageAttributes.entry.1.Name': 'AWS.SNS.SMS.SMSType',
      'MessageAttributes.entry.1.Value.DataType': 'String',
      'MessageAttributes.entry.1.Value.StringValue': 'Transactional',
    },
  },
});
```

## Vendor docs

- API reference: https://docs.aws.amazon.com/sns/latest/api/API_Publish.html
- SMS attributes: https://docs.aws.amazon.com/sns/latest/dg/sms_publish-to-phone.html
- Regional availability: https://docs.aws.amazon.com/sns/latest/dg/sns-supported-regions-countries.html
