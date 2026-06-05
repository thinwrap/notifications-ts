---
title: Notifications-TS Baseline-Coverage Audit
date: 2026-06-04
auditor: Claude Opus 4.8, 1M context
methodology: ≥90%-of-providers baseline rule. Re-verified against current src/ — NOT a blind restatement of prior audits. Provider counts cross-checked against src/providers/, the facade switch arms in src/facades/*.facade.ts, and src/types/provider-id.enum.ts; normalized field surfaces cross-checked against src/types/{email,sms,push,chat}.types.ts and actual connector consumption in src/providers/*/*.connector.ts.
scope: All providers in v1.0 notifications-ts scope — 10 email + 10 SMS + 6 push + 9 chat = 35 connectors. (Vonage is the single canonical id for the Vonage/Nexmo provider; no Novu `nexmo` alias. The provider-id enums total 35 cases.)
predecessor_audit: none — first baseline-coverage audit for notifications-ts (v1.0 is the first public release). Cross-language sibling — notifications-php/audits/baseline-coverage-2026-06-04.md.
commitment: re-audit on provider add/drop or vendor API change; preserved in `audits/`. Release-gate freshness window — ≤14 days at v1.0 release; ≤90 days post-release.
---

# Notifications-TS Baseline-Coverage Audit — 2026-06-04

This audit codifies and re-verifies the v1.0 normalized-facade-surface for the TS
package against current source. Every count and field claim below was checked against
`src/` at audit time rather than copied from a prior artifact.

## Methodology

The ≥90%-of-providers baseline rule: a field belongs on a normalized channel
`<Channel>SendInput` DTO only when ≥90% of providers in that channel support it
natively. Sub-90% fields live in:

- `_passthrough` — the input escape valve (deep-merged into the vendor request body).
- `<Provider>NarrowedInput` / `<Provider>PushSendInput` — per-provider input types
  (wired through `src/types/input-map.type.ts`) extending the channel DTO when
  vendor-specific fields cluster around one provider.
- `raw` on the result DTO — vendor-specific response fields the consumer can opt into.

**Architectural-outlier exception**: a single-provider miss does NOT disqualify a field
from baseline; the connector translates locally at the wire layer. For a 6-provider
channel the ≥90% bar means a field must clear 6/6 — there is no integer count between
5/6 (83.3%) and 6/6 (100%), so a single miss in a push field is a genuine sub-baseline
miss, not an outlier exception. Worked examples that DO qualify as outlier exceptions:
- **SparkPost** (email) — translates baseline `cc` / `bcc` to `recipients[].header_to` +
  `content.headers.CC` at the wire layer, so 9/10 native → 10/10 effective.
- **SES** (email) — `attachments` / `tags` / `customHeaders` implemented via a
  `Content.Raw` MIME builder, so the 10/10 email claim holds for SES.

## Provider Counts — VERIFIED

Counts cross-checked against three independent sources and they agree exactly:

| Channel | Count | Source 1: `src/providers/` dirs | Source 2: facade switch arms | Source 3: provider-id enum |
|---|---|---|---|---|
| Email | 10 | ses, resend, mailgun, sendgrid, postmark, mailersend, mailtrap, brevo, sparkpost, scaleway | 10 arms in `email.facade.ts` | `EmailProviderIdEnum` = 10 |
| SMS | 10 | vonage, twilio, plivo, sns, sinch, telnyx, infobip, messagebird, textmagic, d7networks | 10 arms in `sms.facade.ts` | `SmsProviderIdEnum` = 10 |
| Push | 6 | fcm, expo, apns, one-signal, pusher-beams, wonderpush | 6 arms in `push.facade.ts` | `PushProviderIdEnum` = 6 |
| Chat | 9 | telegram, slack, whatsapp-business, discord, ms-teams, google-chat, mattermost, rocket-chat, line | 9 arms in `chat.facade.ts` | `ChatProviderIdEnum` = 9 |
| **Total** | **35** | 35 dirs | 35 arms | 35 enum cases |

The `src/providers/` directory contains exactly 35 connector folders. The 35-connector
total is confirmed. ✔

## Coverage Percentages — v1.0 (re-verified per channel)

### Email (10: SES, Resend, Mailgun, SendGrid, Postmark, MailerSend, Mailtrap, Brevo, SparkPost, Scaleway)

Normalized `EmailSendInput` fields (from `src/types/email.types.ts`):
required `from`, `to`, `subject`; optional `cc`, `bcc`, `replyTo`, `text`, `html`,
`attachments`, `headers`, `tags`, `_passthrough`.

| Field | Coverage | Baseline? |
|---|---|---|
| from, to, subject, text, html, attachments, headers, tags, replyTo | 10/10 (100%) | yes |
| cc | 9/10 (90.0%) | yes — 10/10 effective via SparkPost connector-translation outlier |
| bcc | 9/10 (90.0%) | yes — 10/10 effective via SparkPost connector-translation outlier |

`EmailAttachment.contentId` (inline-CID) is present on the attachment type but documented
optional (Brevo rejects inline CIDs). No `templateId` on the baseline surface — correctly
deferred. **Email surface conforms.** ✔

### SMS (10: Vonage, Twilio, Plivo, SNS, Sinch, Telnyx, Infobip, MessageBird, TextMagic, D7Networks)

Normalized `SmsSendInput` (from `src/types/sms.types.ts`): optional `from`, required `to`,
required `body`, `_passthrough`.

| Field | Coverage | Baseline? |
|---|---|---|
| to, body | 10/10 (100%) | yes |
| from | 10/10 (optional; alphanumeric-sender / messaging-service variants) | yes |

Per-provider extras (Twilio `MessagingServiceSid`, Sinch `ServicePlanId`, SNS
`MessageAttributes`, etc.) live in the `*NarrowedInput` types / `_passthrough`.
**SMS surface conforms.** ✔

### Push (6: FCM, Expo, APNs, OneSignal, Pusher Beams, WonderPush)

Normalized `PushSendInput` (from `src/types/push.types.ts`): required `to`; optional
`title`, `body`, `data`, `_passthrough` — the 4-field baseline.

Native consumption of the normalized fields, verified by inspecting each
`*.connector.ts` for reads of `input.<field>` (not vendor-side type members):

| Field | FCM | Expo | APNs | OneSignal | Pusher Beams | WonderPush | Coverage | Baseline? |
|---|---|---|---|---|---|---|---|---|
| to, title, body, data | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 6/6 (100%) | yes |
| `badge` | ✗ (only via `options.overrides`) | ✓ | ✓ | ✗ (uses `ios_badgeCount`-style narrowed fields) | ✓ | ✓ | **4/6 (66.7%)** | **NO** |
| `sound` | ✗ (only via `options.overrides`) | ✓ | ✓ | ✗ (uses `ios_sound`/`android_sound` narrowed fields) | ✓ | ✓ | **4/6 (66.7%)** | **NO** |
| `ttl` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ (not consumed) | **5/6 (83.3%)** | **NO** |

**`badge`, `sound`, `ttl` are sub-baseline by design.** All three sit below the ≥90%
native-support bar (which for a 6-provider channel requires 6/6), so they live on the
per-provider narrowed-input types of exactly the providers that natively consume them —
`ExpoInputAugmentation` (badge/sound/ttl), `ApnsInputAugmentation` (badge/sound/ttl),
`PusherBeamsInputAugmentation` (badge/sound/ttl), `WonderPushInputAugmentation`
(badge/sound), `OneSignalInputAugmentation` (ttl), `FcmInputAugmentation` (ttl) — and
NOT on the normalized `PushSendInput`. Non-supporting providers route via
`_passthrough`. The 4-field baseline matches the PHP sibling exactly. ✓

### Chat (9: Telegram, Slack, WhatsApp Business, Discord, MS Teams, Google Chat, Mattermost, Rocket.Chat, LINE)

Normalized `ChatSendInput` (from `src/types/chat.types.ts`): optional `to`, required
`body`, `_passthrough`.

| Field | Coverage | Baseline? |
|---|---|---|
| to (or webhook-URL-as-target), body | 9/9 (100%) | yes |

Webhook providers (Slack, Discord, MS Teams, Google Chat, Mattermost) accept the webhook
URL as implicit `to`; bot providers (Telegram, WhatsApp Business, Rocket.Chat, LINE)
carry explicit `to`. The facade hides the distinction. **Chat surface conforms.** ✔

## Tier Tabulation

The **Tier 2** (auth-heavy) bucket — verified against connector auth handling:

| Provider | Channel | Reason |
|---|---|---|
| `fcm` | push | JWT RS256 + OAuth2 token exchange |
| `apns` | push | JWT ES256 signed locally |
| `ses` | email | AWS SigV4 (hand-rolled, zero deps) |
| `sns` | sms | AWS SigV4 (hand-rolled, zero deps) |

All 31 other connectors are **Tier 1** (static API key / Basic / webhook-URL).

## `tokenCache` Hook Support

The consumer-owned `tokenCache` cache seam is supported on the two connectors whose
short-lived signed tokens dominate per-send latency:

| Provider | Token lifetime |
|---|---|
| `fcm`  | ~1h (Google OAuth2) |
| `apns` | ~1h (Apple JWT) |

Epoch is milliseconds (`Date.now()`) in TS — a documented intentional divergence from the
PHP sibling's seconds. The wrapper holds no state and signs fresh by default; supplying
the hook is purely opt-in.

## Release-Gate Decision

`PASS` — the baseline-coverage discipline holds across all four channels as of
2026-06-04. Email, SMS, and Chat normalized surfaces conform to the ≥90%-of-providers
rule, and the Push channel's normalized `PushSendInput` is the conforming 4-field
baseline (`to`, `title`, `body`, `data`); its sub-baseline fields (`badge` 4/6, `sound`
4/6, `ttl` 5/6 native support) live on the per-provider narrowed-input types of their
native supporters (see §Push), matching the PHP sibling's 4-field `PushSendInput`
exactly. Verification: `tsc --noEmit` clean, 865/865 vitest specs pass.

## Open Questions / v1.1 Roadmap

- Re-spot-check additional providers per channel to reach panel-coverage parity with
  Email within 90 days of the v1.0 release.
- Automate the "no material API change" check via a vendor-changelog diff pipeline.
- Reconsider `templateId` baseline once vendor template engines converge on a
  cross-language `templateVariables` shape.
