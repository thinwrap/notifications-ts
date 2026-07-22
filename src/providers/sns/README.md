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
- SMS attributes: https://docs.aws.amazon.com/sns/latest/dg/sms_sending-overview.html#sms_publish-to-phone
- Regional availability: https://docs.aws.amazon.com/sns/latest/dg/sns-supported-regions-countries.html
