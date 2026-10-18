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
  region: 'ie1',                       // optional processing region ('us1' default)
  edge: 'dublin',                      // optional edge override
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `accountSid` | `string` | yes | Basic-auth username (e.g., `ACxxxxxxx`) |
| `authToken` | `string` | yes | Basic-auth password |
| `from` | `string` | no | E.164; per-call overridable |
| `region` | `'us1' \| 'ie1' \| 'au1'` | no | Processing region; default `'us1'` |
| `edge` | `TwilioEdge` | no | `sydney`, `sao-paulo`, `dublin`, `frankfurt`, `tokyo`, `singapore`, `ashburn`, `umatilla`, `roaming` |

`region` selects where Twilio processes the request (see Twilio's
[non-US region guide](https://www.twilio.com/docs/global-infrastructure/using-the-twilio-rest-api-in-a-non-us-region)
for the credentials a region needs). `ie1` and `au1` are Twilio's only non-US
REST processing regions. The old ids `us2`, `br1`, `de1`, `jp1` and `sg1`
were edge locations whose `api.<id>.twilio.com` hosts stopped resolving on
2026-04-28 (Twilio processes that traffic in us1), so they are rejected with
`invalid_request` before any request is sent. So is any `region` or `edge`
outside the lists above: both values become part of the hostname the
credentials go to.

> **AU1 caveat.** Twilio's regional product-availability page lists only
> Programmable Voice and Elastic SIP Trunking for AU1, not Programmable
> Messaging. The `au1` host exists, but the Messages resource may not be
> available there for your account.

## Auth setup

`Authorization: Basic base64(<accountSid>:<authToken>)` per request. Static.

## Endpoint

Host is `api.{edge}.{region}.twilio.com`; Twilio requires the edge in every
non-US hostname, so each non-US region has a default:

| `region` | `edge` unset | `edge` set |
|---|---|---|
| `us1` (default) | `https://api.twilio.com` | `https://api.{edge}.us1.twilio.com` |
| `ie1` | `https://api.dublin.ie1.twilio.com` | `https://api.{edge}.ie1.twilio.com` |
| `au1` | `https://api.sydney.au1.twilio.com` | `https://api.{edge}.au1.twilio.com` |

Path: `/2010-04-01/Accounts/<SID>/Messages.json`. Form-encoded body. JSON
response. `sendMessage()` uses the same host.

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
| network failure | — | `provider_unavailable` |
| (pre-flight) | unknown `region` / `edge` | `invalid_request` |

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
- Edge locations: https://www.twilio.com/docs/global-infrastructure/edge-locations
- Legacy regions: https://www.twilio.com/docs/global-infrastructure/edge-locations/legacy-regions
- Product availability per region: https://www.twilio.com/docs/global-infrastructure/regional-product-and-feature-availability
