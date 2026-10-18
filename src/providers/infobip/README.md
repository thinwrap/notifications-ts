# Infobip SMS Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'infobip'`.

## Configuration

```typescript
const ib = new Sms('infobip', {
  baseUrl: 'xyz123.api.infobip.com',   // REQUIRED — per-account subdomain
  apiKey: process.env.INFOBIP_KEY!,
  from: 'BrandName',
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `baseUrl` | `string` | yes | Per-account hostname — no scheme, path, port, userinfo or trailing slash. Anything but a bare DNS name → `invalid_request` before any request (the API key is sent to this host) |
| `apiKey` | `string` | yes | Sent as `Authorization: App <apiKey>` |
| `from` | `string` | no | Alphanumeric or E.164 |

## Auth setup

Custom `Authorization: App <apiKey>` scheme. The `baseUrl` is per-account and
provisioned at sign-up — there is no shared global endpoint.

## Endpoint

`POST https://<baseUrl>/sms/2/text/advanced` — `baseUrl` is per account.
The Novu `sendMessage()` surface posts to `/sms/3/messages` with the v3 body
(`messages[].sender`, `destinations[].to`, `content.text`). Both surfaces treat
a 200 whose message status is in the REJECTED group as an error.

## Narrowed input augmentations

Standard SMS input, plus Infobip fields written onto `messages[0]`:
`callbackData`, `notifyUrl`, `notifyContentType`, `flash`, `transliteration`,
`language` (sent as `{ languageCode }`), `validityPeriod` (sent as integer
minutes — the endpoint's only unit; `validityPeriodTimeUnit` is a conversion
hint, rounded up, never sent) and `scheduleSettings.sendAt` (sent as
`messages[0].sendAt`). `bulkId` goes on the request root.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 with destination error | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 200 | `messages[0].status` group 5 (`REJECTED`) with `DESTINATION` / `PREFIX` / `MISSING_TO` / `DND` / `NOT_REGISTERED` in the name | `invalid_recipient` |
| 200 | `REJECTED_FLOODING_FILTER` | `rate_limited` |
| 200 | any other `REJECTED_*` (sender, credits, …) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `provider_unavailable` |

## `_passthrough` examples

```typescript
await ib.send({
  to: '+14155550100',
  body: 'Hi',
  _passthrough: {
    body: { includeSmsCountInResponse: true },
  },
});
```

## Vendor docs

- API reference: https://www.infobip.com/docs/api/channels/sms/sms-api/send-sms-message
- Account base URL: https://www.infobip.com/docs/essentials/base-url
