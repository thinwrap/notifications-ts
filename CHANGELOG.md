# Changelog

All notable changes to `@thinwrap/notifications` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
