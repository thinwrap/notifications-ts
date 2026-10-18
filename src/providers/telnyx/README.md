# Telnyx SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'telnyx'`.

## Configuration

```typescript
const tx = new Sms('telnyx', {
  apiKey: process.env.TELNYX_KEY!,
  from: '+14155550100',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Bearer credential (starts with `KEY…`) |
| `from` | `string` | no | E.164, short code, or alphanumeric sender ID |

## Auth setup

Get an API key at Telnyx → Auth → API V2 keys. Static.

## Endpoint

`POST https://api.telnyx.com/v2/messages` — single global endpoint.

## Narrowed input augmentations

Standard SMS input. Messaging profile, MMS media URLs, delivery webhook via
`_passthrough.body`.

## Error mapping

The vendor `errors[0].code` (a numeric string) is matched first; the HTTP
status is the fallback. Delivery codes `400xx` arrive only in the async
`message.finalized` webhook, never in the send response.

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| (any) | code `40310` (invalid 'to'), `40300` (STOP opt-out), `40309` (invalid destination region); `10002` with `source.pointer: "/to"` | `invalid_recipient` |
| (any) | code `10009`, `10010`, `20001`, `20006`, `40311`, `40313` | `auth_failed` |
| (any) | code `10011`, `40318` (queue full) | `rate_limited` |
| (any) | code `40301`–`40308`, `40314`, `40316`, `40317`, `40319`–`40325`, `40328`, `40331`, `40333`, `10002`, `10004`, `10015`, `20100` | `invalid_request` |
| 401 / 403 | (no recognised code) | `auth_failed` |
| 429 | (no recognised code) | `rate_limited` |
| 400 / 422 / other 4xx | (no recognised code) | `invalid_request` |
| 5xx | (no recognised code) | `provider_unavailable` |
| network failure | — | `provider_unavailable` |

## `_passthrough` examples

```typescript
await tx.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: {
    body: { messaging_profile_id: 'abc-123', webhook_url: 'https://app.example.com/dr' },
  },
});
```

## Vendor docs

- API reference: https://developers.telnyx.com/docs/messaging/messages/send-message
- Errors: https://developers.telnyx.com/docs/messaging/messages/error-codes/index
- API error shape: https://developers.telnyx.com/development/api-fundamentals/api-errors
