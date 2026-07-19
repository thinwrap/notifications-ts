# Twilio SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'twilio'`.

## Configuration

```typescript
const tw = new Sms('twilio', {
  accountSid: process.env.TWILIO_SID!,
  authToken: process.env.TWILIO_TOKEN!,
  from: '+14155550100',
  region: 'us1',                       // optional cluster ('us1' default)
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `accountSid` | `string` | yes | Basic-auth username (e.g., `ACxxxxxxx`) |
| `authToken` | `string` | yes | Basic-auth password |
| `from` | `string` | no | E.164; per-call overridable |
| `region` | `TwilioRegion` | no | Cluster selector; default `'us1'` |

## Auth setup

`Authorization: Basic base64(<accountSid>:<authToken>)` per request. Static.

## Endpoint

Per region:
- `us1` (default): `https://api.twilio.com/2010-04-01/Accounts/<SID>/Messages.json`
- `au1`: `https://api.au1.twilio.com/...`
- `ie1`: `https://api.ie1.twilio.com/...`

Form-encoded body. JSON response.

## Narrowed input augmentations

Standard SMS input. Twilio-specific (`MessagingServiceSid`, `MediaUrl`,
`StatusCallback`) via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 | `code: 21211` (invalid 'To') | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

```typescript
await tw.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: {
    body: {
      MessagingServiceSid: 'MGxxxxxxxxxx',
      StatusCallback: 'https://app.example.com/twilio/status',
    },
  },
});
```

## Vendor docs

- API reference: https://www.twilio.com/docs/messaging/api/message-resource
- Error codes: https://www.twilio.com/docs/api/errors
- Regions: https://www.twilio.com/docs/global-infrastructure/edge-locations
