# Changelog

All notable changes to `@thinwrap/notifications` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-10-18

### Changed

- **Breaking (types):** `TwilioRegion` is now `'us1' | 'ie1' | 'au1'`; `us2`/`br1`/`de1`/`jp1`/`sg1` were removed (their hosts are dead) and are rejected at runtime.
- **Breaking (types):** `EmailAttachment.content` is `string | Uint8Array` and `IAttachmentOptions.file` is `Uint8Array` (a `Buffer` still fits), so the public types no longer need `@types/node`.
- SES: a CR/LF/NUL in a custom header value is now `invalid_request` instead of being flattened to a space.
- APNs: a badge- or sound-only push is now `apns-push-type: alert` (Apple's alert type covers "an alert, badge, or sound").
- APNs: the typed `aps.alert` also accepts a string, sent verbatim (or as `alert.body` when `title`/`body` is set).
- Any request header with CR, LF or NUL is `invalid_request` before the request is built (the message names the header only).

### Fixed

- MS Teams: Workflows webhooks' empty `202 Accepted` is now a success instead of a 502.
- OneSignal: `os_v2_` App API keys now go to `api.onesignal.com` with `Authorization: Key`; caller-supplied targeting suppresses the default recipient.
- OneSignal: a 200 with a notification `id` is a success even when `errors` lists some invalid recipients (kept on `raw`).
- WonderPush: `data`/`sound`/`badge`/`subtitle` now land on the documented `push.custom` and `alert.ios`/`alert.android` fields.
- Infobip: a 200 with a REJECTED message status now throws; `sendAt` moves onto the message and `validityPeriod` is sent as minutes.
- MailerSend: an `ALL_SUPPRESSED` 202 now throws `invalid_recipient`, and `reply_to` is sent as an object.
- Twilio: `ie1`/`au1` use the live `api.{edge}.{region}.twilio.com` hosts, a new `edge` option picks the edge, and `sendMessage()` honours both.
- Twilio: an unknown `region` is `invalid_request` before any credentialed request (was a `provider_unavailable` call to `https://undefined`).
- FCM / APNs: an unusable `privateKey` is `auth_failed` instead of a raw `node:crypto` error.
- FCM: a passthrough `topic`/`condition`/`fid` replaces the seeded `token`; an empty `to` sends no `token`.
- FCM: OAuth token-exchange 429/5xx and transport failures are `rate_limited`/`provider_unavailable`, not `auth_failed` or a raw rejection.
- FCM / APNs: `sendMessage()` now uses `tokenCache` like `.send()`.
- APNs: `429 TooManyProviderTokenUpdates` is `auth_failed` with a message naming `tokenCache`.
- APNs: background pushes get `apns-priority: 5` and `content-available: 1`; an alert set only via `aps`/passthrough is sent as `alert`.
- APNs / FCM: when every `sendMessage()` target fails with the same code, that code and status are thrown instead of a synthetic 500.
- APNs / FCM / Pusher Beams: every 5xx is `provider_unavailable`.
- Pusher Beams: `data` reaches iOS as `apns.data`; a data-only send is a silent push instead of an empty alert.
- Pusher Beams: errors follow the publish-API table (422/404/413 → `invalid_request`, 402 → `rate_limited`, 403 → `auth_failed`).
- FCM: `sendMessage()` now sends `fcmOptions`/`webPush`, maps icon/color/tag/sound/badge to `android.notification`/`apns.payload.aps` (not for `type: 'data'`, which stays silent), and treats a passthrough `condition`/`fid` as one targeted send.
- WonderPush: `sendMessage()` JSON-encodes object passthrough values instead of sending `[object Object]`.
- Pusher Beams / Sinch / SNS / SES / Scaleway: an `instanceId`/`region` that could re-route the credentialed request is `invalid_request`.
- Sinch: `au`, `br` and `ca` regions.
- Infobip: a `baseUrl` that is not a bare hostname is `invalid_request` before the API key is sent.
- Config values used as URL path segments (Sinch `servicePlanId`, Plivo `authId`, Twilio `accountSid`, Telegram `botToken`, FCM `projectId`, WhatsApp `phoneNumberId`/`graphApiVersion`, Beams `instanceId`, Scaleway `region`) are path-escaped; empty or dot values are `invalid_request`.
- Rocket.Chat and every webhook `sendMessage()` path refuse a non-https webhook URL.
- Rocket.Chat: `sendMessage()` honours `options.webhookUrl`, `channel` and the bridge passthrough.
- MS Teams: `sendMessage()` treats a legacy connector's 200-with-error body as an error, like `.send()`.
- Discord: `sendMessage()` appends `wait=true` correctly to a webhook URL that already has a query.
- Slack / Discord / MS Teams / Google Chat / Mattermost: a missing `sendMessage()` webhook URL is `invalid_request`.
- Infobip: `sendMessage()` sends the documented `/sms/3/messages` body (`sender`, `destinations`, `content.text`) and throws on a REJECTED status.
- Telnyx: errors are classified by the documented numeric `errors[].code`; a bare 422 is no longer `invalid_recipient`.
- WhatsApp: error codes follow Meta's table (131047/131008/133010 → `invalid_request`, 131056/131048/130429 → `rate_limited`).
- Telegram: 403 (blocked, kicked, deactivated) is `invalid_recipient` and 404 is `auth_failed`.
- SES: attachments are sent as `Content.Simple.Attachments`; the hand-built raw-MIME path is gone.
- SES: custom headers follow SES's rules (reserved names, printable ASCII, max 15) and are rejected pre-flight otherwise.
- SES: the error code is read from `x-amzn-ErrorType`; `MessageRejected` is `invalid_request`, `SendingPausedException` is `auth_failed`.
- SES: `returnPath` is sent as v2 `FeedbackForwardingEmailAddress` (new `feedbackForwardingEmailAddress` field); invalid tags are rejected pre-flight.
- SES / Resend / Postmark / Mailgun: sender display names are quoted or RFC 2047-encoded, so `Acme, Inc.` and non-ASCII names work; a `from` already written as `Name <addr>` is parsed, never nested.
- SES: `checkIntegration()` without options reports that it needs them instead of a `TypeError`; a tag object with no `Value` is rejected pre-flight.
- Email `sendMessage()` paths now send `options.headers` and map `cid` inline images (SendGrid, Mailtrap, MailerSend, Postmark, Mailgun).
- Resend: inline attachments send `content_id`; invalid tags are rejected pre-flight.
- Postmark: `ErrorCode` mapping follows Postmark's table (406 recipient, 411 request, 412/413 auth); 300 is `invalid_recipient` only for a To/Cc/Bcc address; other 4xx are `invalid_request`.
- Postmark: a `TemplateId`/`TemplateAlias` in the merged body routes to `/email/withTemplate` without `Subject`/`HtmlBody`/`TextBody` (and with `TemplateModel: {}` when absent), on `sendMessage()` too.
- Mailgun: 403 is `auth_failed`, an http `baseUrl` is refused, list/dict passthrough values are repeated fields / JSON, and duplicate header case-variants (typed or passthrough) collapse.
- Mailgun: an inline part's filename is its `contentId`, since Mailgun uses the filename as the Content-ID.
- SparkPost: inline images are named by `contentId`, `type` is always sent, and 420 is `rate_limited`.
- MailerSend: attachments no longer send the non-existent `content_type` field.

### Documentation

- APNs: `tokenCache` is required in production.
- README: which failures are `ConnectorError`; every connector's network failure is `provider_unavailable`.
- FCM: the topic-send example nests `topic` under `message`.

## [1.1.1] — 2026-08-08

### Fixed

- Every provider error collapsed into `provider_unavailable` with a null status when the host
  application's `fetch` rejects on a non-2xx; the transport seam now rebuilds the `Response`.
- A transport rejection could surface the credential-bearing request URL into
  `ConnectorError.message` and `.cause` — for Telegram and every webhook provider, the URL
  *is* the credential (CWE-532).

### Changed

- **Behaviour change:** `ConnectorError.message` on a transport failure is now a
  fixed `Network error` / `Request cancelled`. Diagnostics moved to `cause.raw.code`.

### Documentation

- README: the transport contract, host-dispatcher isolation, and why transport failures carry
  no message detail.

## [1.1.0] — 2026-07-24

### Changed

- **`_passthrough.body` nested keys now pass through verbatim.** `transformKeys`
  gained an opt-out `deep` flag; connectors normalising `_passthrough.body` now
  transform only top-level keys, leaving nested data-carrying maps — SendGrid
  `dynamic_template_data`, SparkPost `substitution_data`, Postmark `templateModel`
  and similar — with the consumer's exact key casing instead of silently
  camelCase-rewriting template variables and metadata.

### Fixed

- **APNs fails fast without an HTTP/2 transport.** Apple's push service mandates
  HTTP/2 and Node's built-in `fetch` (undici) is HTTP/1.1-only, so when no
  HTTP/2-capable transport is injected the connector now throws a clear
  `ConnectorError` up front instead of emitting an opaque mid-request network
  error. A consumer-supplied HTTP/2-capable `fetch` is unaffected.
- **Connector hardening (second/third review pass)** — error-classification and
  response-parsing corrections across the email, SMS, push, and chat connectors.

### Security

- **Credential redaction is centralised** in a new `redact` utility and applied
  consistently. Providers whose credential lives in the request URL — the
  Slack / Google Chat / MS Teams / Mattermost / Rocket.Chat / Discord webhooks
  and the Telegram bot token — now scrub that secret from any transport-error
  message a BYO `fetch` may surface and reduce the stored `cause` to a
  non-sensitive shape.
- **Webhook chat providers reject non-`https://` URLs**, so a stale or mistyped
  config cannot send the webhook credential over cleartext.

## [1.0.3] — 2026-07-20

### Changed

- **Per-connector READMEs** no longer carry a YAML frontmatter block — the
  metadata GitHub rendered as a table but nothing consumed. The frontmatter
  validator (`scripts/validate-frontmatter.mjs`), its schema, and the CI gate
  that ran it have been removed. Per-connector docs are now plain Markdown.

### Fixed

- **Non-ASCII email content** is now encoded as UTF-8. `encodeBase64Ascii`
  encoded its input as latin1, corrupting non-ASCII text (accents, emoji, CJK)
  in the SES raw-MIME message and in string attachments across nine email
  connectors (Resend, SendGrid, Brevo, Postmark, Mailtrap, SparkPost,
  MailerSend, Scaleway, SES), and threw on runtimes whose `btoa` rejects code
  points > U+00FF. Content is now base64-encoded from UTF-8 bytes.
- **SES raw-MIME conformance** — attachment base64 is line-wrapped at 76
  characters (RFC 5322) and the text/plain & text/html parts declare
  `Content-Transfer-Encoding: 8bit` (was `7bit`) over their UTF-8 bodies.
- **Edge-runtime portability** — `transformKeys` no longer throws a
  `ReferenceError` on runtimes without a global `Buffer`.

### Security

- **Discord** webhook URLs (which are the entire credential) are now redacted
  from error output, matching the Telegram bot-token redaction.

## [1.0.2] — 2026-06-05

First public release of `@thinwrap/notifications` — a unified, baseline-
coverage-disciplined TypeScript facade over 35 notification providers
across Email / SMS / Push / Chat.

### Public surface (locked at v1.0)

- **4 unified facades**: `Email`, `Sms`, `Push`, `Chat`.
- **35 per-provider connectors**:
  - **Email (10)**: `SesEmailConnector`, `ResendEmailConnector`,
    `MailgunEmailConnector`, `SendgridEmailConnector`,
    `PostmarkEmailConnector`, `MailerSendEmailConnector`,
    `MailtrapEmailConnector`, `BrevoEmailConnector`,
    `SparkPostEmailConnector`, `ScalewayEmailConnector`.
  - **SMS (10)**: `VonageSmsConnector` (also registered under the `nexmo`
    alias for Novu compatibility), `TwilioSmsConnector`,
    `PlivoSmsConnector`, `SnsSmsConnector`, `SinchSmsConnector`,
    `TelnyxSmsConnector`, `InfobipSmsConnector`,
    `MessageBirdSmsConnector`, `TextmagicSmsConnector`,
    `D7NetworksSmsConnector`.
  - **Push (6)**: `FcmPushConnector`, `ExpoPushConnector`,
    `ApnsPushConnector`, `OneSignalPushConnector`,
    `PusherBeamsPushConnector`, `WonderPushPushConnector`.
  - **Chat (9)**: `TelegramChatConnector`, `SlackChatConnector`,
    `WhatsAppChatConnector`, `DiscordChatConnector`,
    `MsTeamsChatConnector`, `GoogleChatChatConnector`,
    `MattermostChatConnector`, `RocketChatChatConnector`,
    `LineChatConnector`.
- **Error model**: `ConnectorError` + 6-value `ProviderCode` type
  (`invalid_recipient`, `rate_limited`, `auth_failed`,
  `provider_unavailable`, `invalid_request`, `unknown`). There is no
  top-level `retryAfterSeconds` field — the wrapper performs no automatic
  retry. `e.cause` carries the raw vendor response (`cause.raw`), the raw
  `Retry-After` value (`cause.retryAfter`), and parsed seconds
  (`cause.retryAfterSeconds`) where the vendor provides one.
- **Result shape**: `{ success, status, providerMessageId, raw }` per
  channel with `status: 'sent' | 'queued' | 'rejected' | 'suppressed' | 'unknown'`.
- **Config types**: one `<Provider>Config` per connector exported from
  `@thinwrap/notifications`.
- **Novu drop-in compat surface**: every connector implements
  `IEmailProvider` / `ISmsProvider` / `IPushProvider` / `IChatProvider`
  with a `sendMessage(options)` adapter. Migration recipe in
  [MIGRATION.md](./MIGRATION.md).

### Properties

- **Zero runtime dependencies**: AWS Sig V4 (SES + SNS) is hand-rolled
  against `node:crypto`; everything uses native `fetch` (Node ≥18).
- **Sigstore provenance** — `npm publish --provenance` via OIDC; no
  long-lived npm token consumed.
- **Wrapper holds no state** — no token cache, no connection pool, no
  retry buffer. FCM/APNs token caching is optional, BYO via a
  `tokenCache` hook config.
- **Bring-your-own `fetch`** — connector and facade constructors accept
  any fetch-compatible function for tracing, mocking, or routing through
  `undici`.
- **Bundle-size discipline**:
  - Tier A (31 connectors, ≤ 15 KB gzipped each).
  - Tier B (`fcm`, `apns`, `ses`, `sns`, ≤ 30 KB gzipped each).
  - Single-provider imports tree-shake cleanly (verified by
    `npm run check:tree-shaking` and the `size-limit` CI gate).
- **Dual build**: ESM (`import`) + CJS (`require`). Full TypeScript types.

### Baseline-coverage discipline

The unified facade surface includes only features ≥90% of providers
natively support in their primary send API. Sub-baseline fields are
accessible via provider-id-narrowed augmented input types and the
`_passthrough` escape hatch.

### Migration

This is the first public release under the `@thinwrap/notifications`
name; there are no prior published versions.

The README's Migrating section + [MIGRATION.md](./MIGRATION.md) document
the recipe for moving off `@novu/providers`.

### Cross-language

Companion package `thinwrap/notifications` publishes simultaneously on
Packagist with the same facade names, error model, result shapes, and
35 provider IDs.

[1.0.2]: https://github.com/thinwrap/notifications-ts/releases/tag/v1.0.2
