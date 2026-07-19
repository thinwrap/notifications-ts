# WhatsApp Business Chat Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'whatsapp-business'`.

## Configuration

```typescript
const wa = new Chat('whatsapp-business', {
  accessToken: process.env.META_WA_TOKEN!,
  phoneNumberId: process.env.META_WA_PHONE_NUMBER_ID!,
  graphApiVersion: 'v21.0',                 // optional; default 'v21.0'
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessToken` | `string` | yes | Meta Business Manager system-user token (Bearer) |
| `phoneNumberId` | `string` | yes | Numeric phone-number ID — NOT the phone number itself |
| `graphApiVersion` | `string` | no | Graph API version segment; default `v21.0` |

## Auth setup

In Meta Business Manager → Business settings → System users, generate a
system-user token with WhatsApp Business permissions. Get the
`phoneNumberId` from WhatsApp Manager. Both are long-lived; static.

## Endpoint

`POST https://graph.facebook.com/<graphApiVersion>/<phoneNumberId>/messages`.

## Narrowed input augmentations

Standard chat input (`to` is the recipient E.164 number, `body` is text).
Templated sends, interactive components, media attachments via
`_passthrough.body`. WhatsApp policy requires a template for any first
contact or for messages sent outside the 24h customer-service window — use
`_passthrough.body.template`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 | (any) | `auth_failed` |
| 400 `code: 131026` (invalid number) | `invalid_recipient` |
| 400 | (other) | `invalid_request` |
| 429 | (any) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Template send (required outside 24h window):

```typescript
await wa.send({
  to: '14155550100',                 // E.164 without leading '+'
  body: 'unused for template',
  _passthrough: {
    body: {
      type: 'template',
      template: {
        name: 'hello_world',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Alice' }] }],
      },
    },
  },
});
```

## Vendor docs

- API reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
- Templates: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
- 24h window: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
- Errors: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
