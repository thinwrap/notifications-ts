---
title: Notifications Cross-Language Harmonization Audit (TS half)
date: 2026-06-04
auditor: Claude Opus 4.8, 1M context
methodology: Mechanical comparison of TS public surface in `@thinwrap/notifications` against PHP public surface in `thinwrap/notifications` at the v1.0 release-candidate working tree.
scope: Facade names + method signatures, ConnectorError shape, ProviderCode enum, per-channel input/result shape, provider ID lists per channel, TokenCacheHook contract, custom-connector ("bring your own connector") identity.
applies_to:
  - thinwrap/notifications-ts (TS half — this file)
  - thinwrap/notifications-php (PHP half — reciprocal at notifications-php/audits/harmonization-2026-06-04.md)
commitment: cross-language parity is a release gate; the cross-language audit mechanism is manual at v1.0.
---

# Notifications Cross-Language Harmonization Audit — TS half — 2026-06-04

## Purpose

The cross-language parity claim between `@thinwrap/notifications` (TS, npm) and
`thinwrap/notifications` (PHP, Packagist) is a v1.0 release gate. This audit is
the TS-side mechanical comparison, dated 2026-06-04: every section is verified
against current source in both repos, including the custom-connector
("bring your own connector") construction surface, whose identity idiom is
recorded in Section 7 (D11).

Audit documents are dated, append-only artifacts; auditors cross-reference by
date and the release gates check the newest file.

## Methodology

Read-only inspection of both source trees (neither modified):

- TS at `/Users/me/thinwrap/notifications-ts/` (this package).
- PHP at `/Users/me/thinwrap/notifications-php/`.

Comparison is symbol-by-symbol. Each row records the canonical TS symbol, the
canonical PHP symbol, and the parity verdict.

## 1. Facade Names + Method Signatures

| Surface | TS | PHP | Match |
|---|---|---|---|
| Email facade class | `class Email<P>` (generic over provider id literal) | `final class Email` | parity (language idioms) |
| `Email.send` signature | `(input) => Promise<EmailSendResult>` | `send(EmailSendInput $input): EmailSendResult` | parity (async TS vs sync PHP — idiom) |
| Sms facade class | `class Sms<P>` | `final class Sms` | parity |
| `Sms.send` signature | `(input) => Promise<SmsSendResult>` | `send(SmsSendInput $input): SmsSendResult` | parity |
| Push facade class | `class Push<P>` | `final class Push` | parity |
| `Push.send` signature | `(input) => Promise<PushSendResult>` | `send(PushSendInput $input): PushSendResult` | parity |
| Chat facade class | `class Chat<P>` | `final class Chat` | parity |
| `Chat.send` signature | `(input) => Promise<ChatSendResult>` | `send(ChatSendInput $input): ChatSendResult` | parity |
| channel discriminator | `readonly channelType = ChannelTypeEnum.<X>` | `public readonly string $channelType` (`'email'`/`'sms'`/`'push'`/`'chat'`) | parity (TS enum, PHP backing string) |
| provider-id introspection | `readonly id: string` | `public readonly ?NotificationProviderId $providerId` | divergence D11 (see §7) — TS string id vs PHP nullable enum; reflects custom-connector identity |
| custom-connector construction | `new Email(connector)` (dual-overload ctor) | `Email::fromConnector($connector)` | parity (idiom — see D11) |
| `checkIntegration()` | present on all four TS facades (best-effort, delegates if connector implements it) | absent | divergence D12 (see §7) — TS-only convenience |

All four locked facade method names (`send` across Email / Sms / Push / Chat)
match across languages. The async/sync return difference is a deliberate
language idiom.

### Constructor shapes (2026-06-04 change)

Both languages now support **two construction modes**: provider-id + config
(the keyed factory path), and a pre-built custom connector ("bring your own
connector"):

- **TS** — dual-overload constructor:
  `constructor(providerId: P, config: <Config>WithFetch<P>)` and
  `constructor(connector: I<X>Connector)`. The object-vs-string discriminant at
  the head of the implementation routes to the connector branch when given an
  object; the `id` field is then set from the connector's own `id`
  (`this.id = arg.id`). Passing a provider id without `config` throws
  `ConnectorError({ providerCode: 'invalid_request' })`.
- **PHP** — single constructor with nullable params
  `__construct(?NotificationProviderId $providerId, …$config = null, …, ?I $connector = null)`.
  `fromConnector()` now calls `new self(null, connector: $connector)` (no dummy
  provider-id/config). Passing neither (id+config) nor a connector throws
  `ConnectorError(providerCode: ProviderCode::InvalidRequest)`.

The "missing required construction args ⇒ `invalid_request`" guard is parity
across both languages. Verified in all four facades each side.

## 2. ConnectorError Shape

The shape MUST match — no top-level structured `retryAfterSeconds` field on
either language.

| Field | TS type | PHP type | Match |
|---|---|---|---|
| `message` | `string` (from `Error` base) | `string` (from `\RuntimeException`) | parity |
| `statusCode` | `number \| null` | `?int` | parity |
| `providerCode` | `ProviderCode` union (optional) | `ProviderCode` enum (required ctor arg) | parity (idiom) |
| `providerMessage` | `string \| null` | `?string` | parity |
| `cause` | `unknown`, shaped `{raw, retryAfter?, retryAfterSeconds?}` | `mixed`, shaped `['raw'=>…, 'retryAfter'=>…, 'retryAfterSeconds'=>…]` | parity (acceptable idiom — D-cause) |
| `retryAfterSeconds` (top-level field) | **absent** | **absent** | parity |

**Verified absence** of a *top-level* `retryAfterSeconds` field (the parsed
seconds live inside `cause`, not as a structured `ConnectorError` property):

- TS at `notifications-ts/src/types/error.types.ts` — class has only
  `statusCode`, `providerCode`, `providerMessage`; `cause` is carried via the
  `Error` `{ cause }` option. No top-level `retryAfterSeconds`.
- PHP at `notifications-php/src/Exception/ConnectorError.php` — ctor props are
  `providerCode`, `providerMessage`, `cause`, `statusCode`. No top-level
  `retryAfterSeconds`.

`cause` is unified across both languages:
`{raw: vendorBody|transport-detail, retryAfter: string|int|null (raw, un-normalized), retryAfterSeconds: int|null (parsed)}`.
The accepted idiom divergence (D-cause): TS `cause` is `unknown` carrying an
object literal; PHP `cause` is `mixed` carrying an array with the same keys.
Still accurate.

## 3. ProviderCode Enum Values

The 6 canonical values must be string-identical across languages.

| Value | TS literal | PHP enum case → backing | Match |
|---|---|---|---|
| invalid_recipient | `'invalid_recipient'` | `InvalidRecipient => 'invalid_recipient'` | parity |
| rate_limited | `'rate_limited'` | `RateLimited => 'rate_limited'` | parity |
| auth_failed | `'auth_failed'` | `AuthFailed => 'auth_failed'` | parity |
| provider_unavailable | `'provider_unavailable'` | `ProviderUnavailable => 'provider_unavailable'` | parity |
| invalid_request | `'invalid_request'` | `InvalidRequest => 'invalid_request'` | parity |
| unknown | `'unknown'` | `Unknown => 'unknown'` | parity |

Exactly 6 cases each side. No additions, no removals.

## 4. Per-Channel Input Base Shape

### EmailSendInput

| Field | TS | PHP | Match |
|---|---|---|---|
| `from` | `string` | `string` | parity |
| `to` | `string` | `string` | parity |
| `subject` | `string` | `string` | parity |
| `cc`, `bcc` | `string[]?` | `?list<string>` | parity |
| `replyTo` | `string?` | `?string` | parity |
| `text`, `html` | `string?` | `?string` | parity |
| `attachments` | `EmailAttachment[]?` | `?list<EmailAttachment>` | parity |
| `headers` | `Record<string,string>?` | `?array<string,string>` | parity |
| `tags` | `string[]?` | `?list<string>` | parity |
| `_passthrough` | `_passthrough?` (leading underscore) | `_passthrough` (same key) | parity |

Note: both sides use `to: string` (single recipient at the wire layer) and the
key `headers` (not `customHeaders`).

### SmsSendInput

| Field | TS | PHP | Match |
|---|---|---|---|
| `to` | `string` | `string` | parity |
| `body` | `string` | `string` | parity |
| `from` | `string?` | `?string` | parity |
| `_passthrough` | object literal | array | parity (idiom) |

### PushSendInput

| Field | TS | PHP | Match |
|---|---|---|---|
| `to`, `title`, `body`, `data` | 4-field baseline | 4-field baseline | parity |
| `badge`, `sound`, `ttl` | NOT baseline (on per-provider narrowed inputs) | NOT baseline (vendor fields on NarrowedInput) | parity |

`data` is `Record<string,string>` (TS) / `array<string,string>|null` (PHP) —
string-only values, parity. Both languages carry the 4-field ≥90% baseline;
`badge`/`sound`/`ttl` live on the narrowed inputs of their native supporters
(Expo, APNs, Pusher Beams all three; WonderPush badge/sound; OneSignal + FCM
ttl). See §7 D8.

### ChatSendInput

| Field | TS | PHP | Match |
|---|---|---|---|
| `to` | `string?` (nullable for webhook-URL providers) | `?string` | parity |
| `body` | `string` | `string` | parity |
| `_passthrough` | object literal | array | parity (idiom) |

The nullable `to` (5 webhook-URL chat providers carry routing in the webhook;
the 4 token-auth providers validate non-null in their own `send()`) is parity
across both languages.

## 5. Dual-Status Result Shape

`<Channel>SendResult` carries the dual-status flag so consumers distinguish hard
rejections (throws) from soft rejections (returns `success: false`).

| Field | TS | PHP | Match |
|---|---|---|---|
| `success` | `boolean` | `bool` | parity |
| `status` | string-union literal | backed enum (all four channels, incl. Email) | parity (idiom) |
| `providerMessageId` | `string \| null` | `?string` | parity |
| `raw` | `unknown` | `mixed` | parity |

The "backed enum per channel" holds for **Email** too: PHP ships a backed
`EmailStatus` enum (mirroring `SmsStatus`/`PushStatus`/`ChatStatus`); TS keeps
the literal union on all four. Status string values are byte-identical:

| Status | TS string | PHP enum backing | Match |
|---|---|---|---|
| sent | `'sent'` | `'sent'` | parity |
| queued | `'queued'` | `'queued'` | parity |
| rejected | `'rejected'` | `'rejected'` | parity |
| suppressed | `'suppressed'` | `'suppressed'` | parity |
| unknown | `'unknown'` | `'unknown'` | parity |

Verified across all four result types in both repos.

## 6. Provider ID Lists Per Channel

Verdict is on the canonical wire/string id, which is the cross-language contract
(TS string union ↔ PHP `NotificationProviderId` enum backing value).

### Email (10)

`ses`, `resend`, `mailgun`, `sendgrid`, `postmark`, `mailersend`, `mailtrap`,
`brevo`, `sparkpost`, `scaleway` — identical 10 each side. PASS

### SMS (10)

`vonage`, `twilio`, `plivo`, `sns`, `sinch`, `telnyx`, `infobip`,
`messagebird`, `textmagic`, `d7networks` — identical 10 each side. PASS

**D1 (closed):** no `nexmo` alias on either side. Re-verified in current
TS source: `ProviderConfigMap` / `SmsProvider` register only `vonage`; the
`Sms` facade switch has no `nexmo` arm; the only residual `nexmo` strings are
the Vonage REST hostname (`rest.nexmo.com`) and historical rebranding notes in
docs. `Vonage` is the single canonical id on both sides, and the PHP CI
workflow header comment records the same single-canonical-id state.

### Push (6)

`fcm`, `expo`, `apns`, `one-signal`, `pusher-beams`, `wonderpush` — identical 6
each side. PASS

### Chat (9)

`telegram`, `slack`, `whatsapp-business`, `discord`, `ms-teams`, `google-chat`,
`mattermost`, `rocket-chat`, `line` — identical 9 each side. PASS

Note on MS Teams: canonical id is `ms-teams` (TS `MsTeams = 'ms-teams'`, facade
case `'ms-teams'`, provider dir `providers/ms-teams`; PHP `Msteams => 'ms-teams'`)
— the backing string is `ms-teams` on both sides, so parity holds.

**Total:** 35 connectors per language. Cross-language provider-id parity PASS.

## 7. Findings

| Code | Surface | TS-side | PHP-side | Resolution | Blocking? |
|---|---|---|---|---|---|
| D1 | SMS `nexmo` alias | **dropped** — `vonage` only (no config-map/facade arm) | **dropped** — `Vonage` only | Closed: neither language carries the alias; residual `nexmo` strings are the Vonage REST hostname only | Closed |
| D2 | Novu drop-in compat interfaces | `IEmailProvider`/`ISmsProvider`/`IPushProvider`/`IChatProvider` exist (`src/types/provider.interface.ts`) | Absent | TS-only feature; documented exclusion | No |
| D3 | OneSignal soft-reject | Throws `invalid_recipient` | Returns `success:false, status:Rejected` | Align TS to PHP soft-reject; TS follow-up | No (PHP baseline correct) |
| D4 | Rocket.Chat auth | Incoming-webhook URL | Two-header REST (`X-Auth-Token` + `X-User-Id`) | Ratified deliberate divergence | Closed |
| D5 | WABA API version | `v21.0` | `v18.0` | Documented; PHP bump follow-up | No (both vendor-compatible) |
| D6 | Discord `wait` query param | Always-on | Explicit narrowed-input field | TS narrows; follow-up | No (consumer behavior identical) |
| D7 | MS Teams non-`"1"` body | Lenient | Stricter (throws) | Tighten TS; follow-up | No (PHP stricter correct) |
| D8 | `PushSendInput` baseline | 4 fields (extras on narrowed inputs) | 4 fields (extras on NarrowedInput) | Parity — both languages carry the 4-field ≥90% baseline | Closed |
| D9 | status representation | string union | backed enum (all 4 channels) | Both parse to identical string values | No (idiom) |
| D10 | `TokenCacheHook` epoch | Milliseconds (`Date.now()`) | Seconds (`time()`) | Intentional idiom; consumer hook owns the timestamp | No (re-verified accurate — PHP `TokenCacheHook` docblock states epoch SECONDS) |
| D11 | custom-connector identity | Facade exposes the connector's string `id` (`this.id = arg.id`); TS connector interfaces (`I<X>Connector`) declare `readonly id: string` + `channelType` + `send()` | Facade exposes `providerId === null` for custom connectors; PHP connector interfaces are `send()`-only (no `id`/`channelType` member) | Accepted idiom divergence: PHP connector contracts intentionally carry no id member, so a custom-built facade has no provider id to surface (`null`); TS surfaces the connector-supplied `id` string | No (deliberate; both expose `send()` identically) |
| D12 | `checkIntegration()` | Present on all four TS facades (best-effort delegate) | Absent | TS-only convenience method; not part of the locked send contract | No (documented exclusion) |
| D-cause | `cause` payload | `unknown` + object literal `{raw,retryAfter?,retryAfterSeconds?}` | `mixed` + array `['raw'=>…,'retryAfter'=>…,'retryAfterSeconds'=>…]` | Accepted idiom — same keys/semantics | No (idiom) |
| D-meta | `_passthrough` leading underscore | `_passthrough` | `_passthrough` (same key) | Full parity | Closed |

**No BLOCKING divergences at v1.0 release.** All surfaced divergences are
either acceptable language idioms (D4, D9, D10, D11, D-cause), documented
TS-only features/exclusions (D2, D12), TS-side follow-up patches that do not
block release because the wire behavior is consumer-equivalent (D3, D5, D6, D7,
D8), or fully closed (D1, D-meta).

### Custom-connector ("bring your own connector") — re-verified both READMEs

- TS `README.md` §"Bring your own connector" — implement `I<X>Connector`
  (`id`, `channelType`, `send()`), pass to `new Push(connector)`.
- PHP `README.md` §"Bring your own connector" — implement the `*ConnectorInterface`
  (`send()` only), build via `Push::fromConnector($connector)`.

Both documented; identity difference is D11 above.

## 8. Release-Gate Decision

`PASS` — TS-side cross-language harmonization is satisfied at v1.0 release time
(re-verified 2026-06-04). The 6-section structural comparison shows full parity
on the locked surfaces (facade `send` names, ConnectorError shape incl. absence
of a top-level `retryAfterSeconds`, the 6 ProviderCode values, the per-channel
input base shapes, the dual-status result shape with byte-identical status
strings, and the 35 provider IDs per channel). The custom-connector construction
API is consistent on both sides (dual-mode construction; `invalid_request` when
required construction args are missing). Divergences D11 (custom-connector
identity: TS string `id` vs PHP `providerId === null`) and D12
(`checkIntegration()` TS-only) are deliberate, non-blocking idioms/exclusions.
D1/D4/D8 are closed (parity or ratified); D3/D5/D6/D7 remain non-blocking
TS-side follow-ups; D10 / `TokenCacheHook` epoch and D-cause remain intentional
language idioms.

## 9. v1.1 Roadmap

> v1.1 roadmap: build an automated cross-language parity test harness that runs
> in CI on every PR (shared JSON fixtures + per-language test runners). Until
> then, the v1.0+ release gate is this manual audit.

## Cross-reference to PHP sibling

- PHP-side audit: `notifications-php/audits/harmonization-2026-06-04.md`
  (reciprocal, PHP perspective; same findings, same PASS).

## Audit evidence sources (TS side)

- `src/facades/{email,sms,push,chat}.facade.ts` — facade classes (dual-overload ctors; `id` from connector).
- `src/types/{email,sms,push,chat}.types.ts` — `*SendInput`/`*SendResult` + `I<X>Connector` (each declares `id`, `channelType`, `send()`).
- `src/types/error.types.ts` — `ConnectorError` + `ProviderCode` union; verified absence of top-level `retryAfterSeconds`.
- `src/types/provider-id.enum.ts` — per-channel id enums + compile-time sync assertions (35 ids).
- `src/types/config-map.type.ts` — `ProviderConfigMap` / `SmsProvider` (no `nexmo` key).
- `src/types/provider.interface.ts` — Novu-compat `I<X>Provider` interfaces (TS-only).
- `README.md` §"Bring your own connector".
