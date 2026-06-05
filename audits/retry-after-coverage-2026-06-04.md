# Retry-After coverage matrix — 2026-06-04

Status of per-connector `Retry-After` test coverage in
`@thinwrap/notifications` (TypeScript). This is a dated, append-only
snapshot. Each `OK` cell was **re-verified against the current spec
files** on 2026-06-04 — no cell was copied forward blind.

What an `OK` cell means in code is anchored by the canonical assertion
pattern in [`.ai/TEST-FIXTURES.md`](../.ai/TEST-FIXTURES.md) §1 and the
shared fixture helper
[`src/test-utils/retry-after-fixture.ts`](../src/test-utils/retry-after-fixture.ts)
(`createRetryAfterFixture`).

---

## What was verified per cell

For every connector spec
`src/providers/<id>/<id>.connector.spec.ts`, the audit confirmed:

1. The spec imports and uses `createRetryAfterFixture` from
   `src/test-utils` (the marker that the canonical fixture shape is used).
2. A **429** case asserts the dual-field surfacing on `cause`:
   - `cause.retryAfter` — the **raw** `Retry-After` header value, as a
     string (e.g. `'30'`).
   - `cause.retryAfterSeconds` — the **parsed** seconds value, as a number,
     inside the raw cause bag.
   - `providerCode === 'rate_limited'`.
3. There is **no** top-level `retryAfterSeconds` field on `ConnectorError`
   (`src/types/error.types.ts` carries none — invariant holds).

### Important: code reality vs. the doc's canonical example

`.ai/TEST-FIXTURES.md` §1 shows an aspirational example asserting the
parsed seconds via `providerMessage: expect.stringContaining('30')`. The
**actual** implemented and asserted contract across all 35 connectors is
the `cause` dual-field shape:

```ts
cause: { raw, retryAfter: '<rawHeader>', retryAfterSeconds?: <parsed> }
```

i.e. `cause.retryAfter` (raw string) + `cause.retryAfterSeconds` (parsed
number, present only when the header/body parsed to a value). Each
connector's `*.connector.ts` builds this via `parseRetryAfter()` from
[`src/utils/retry-after.ts`](../src/utils/retry-after.ts) and sets
`cause.retryAfterSeconds` conditionally (`if (retryAfterSeconds != null)`).
The only connector that **also** embeds the parsed seconds into
`providerMessage` text is **scaleway**
(`... (Retry-After: <n> seconds)`).

---

## Coverage matrix

Legend: **OK** = 429 dual-field (`cause.retryAfter` + `cause.retryAfterSeconds`)
asserted via `createRetryAfterFixture`. **503** column = an explicit
`provider_unavailable` 503/5xx case is also asserted in the same spec.
**Source** = where the connector reads the retry signal.

| Connector | createRetryAfterFixture | 429 dual-field | 503 → provider_unavailable | Retry signal source |
|---|---|---|---|---|
| apns | OK | OK | — (tokenCache 503 paths present) | header |
| brevo | OK | OK | — | header |
| d7networks | OK | OK | — | header |
| discord | OK | OK | — | body `retry_after` (float → ceil) **and** header |
| expo | OK | OK | — | header |
| fcm | OK | OK | — | header |
| google-chat | OK | OK | — | header |
| infobip | OK | OK | — | header |
| line | OK | OK | — | header |
| mailersend | OK | OK | — | header |
| mailgun | OK | OK | — | header |
| mailtrap | OK | OK | — | header |
| mattermost | OK | OK | — | header |
| messagebird | OK | OK | — | header |
| ms-teams | OK | OK | — | header |
| one-signal | OK | OK | OK | header |
| plivo | OK | OK | — | header |
| postmark | OK | OK | — | header |
| pusher-beams | OK | OK | — | header |
| resend | OK | OK | — | header |
| rocket-chat | OK | OK | — | header |
| scaleway | OK | OK | — | header (also embeds seconds in providerMessage) |
| sendgrid | OK | OK | — | header |
| ses | OK | OK | — | header |
| sinch | OK | OK | — | header |
| slack | OK | OK | — | header |
| sns | OK | OK | OK (5xx + 503) | header |
| sparkpost | OK | OK | — | header |
| telegram | OK | OK | — | body `parameters.retry_after` (header deliberately absent) |
| telnyx | OK | OK | — | header |
| textmagic | OK | OK | — | header |
| twilio | OK | OK | — | header |
| vonage | OK | OK | — | header |
| whatsapp-business | OK | OK | — | header |
| wonderpush | OK | OK | — | header |

**Totals:** 35 / 35 connectors have verified 429 dual-field Retry-After
coverage. 2 connectors (one-signal, sns) additionally assert an explicit
503/5xx `provider_unavailable` case in the same spec. Header-only `—` in
the 503 column means no dedicated 503 Retry-After assertion exists; it does
**not** indicate missing 429 coverage.

### Outliers worth knowing

- **discord** — vendor returns `retry_after` (seconds, float) in the JSON
  body. Spec asserts `cause.retryAfterSeconds = ceil(seconds)` for the body
  form **and** a separate RFC-7231 header form asserting raw + parsed.
- **telegram** — vendor returns `parameters.retry_after` in the JSON body
  and emits **no** `Retry-After` header; the fixture deliberately omits the
  header. Spec asserts `cause.retryAfter: '30'` + `cause.retryAfterSeconds: 30`.
- **scaleway** — only connector that also embeds the parsed seconds in
  `providerMessage` text.
- **apns / fcm** — push-token connectors; their specs additionally exercise
  the `tokenCache` hook paths (see `.ai/TEST-FIXTURES.md` §2), independent
  of Retry-After.

---

## Verification summary

State as verified on 2026-06-04:

- **35 / 35** connector specs use `createRetryAfterFixture` and assert the
  429 dual-field (`cause.retryAfter` raw string + `cause.retryAfterSeconds`
  parsed number) contract. No connector is missing 429 coverage.
- No top-level `retryAfterSeconds` field exists on `ConnectorError`
  (`src/types/error.types.ts`) — the core invariant holds.
- The canonical assertion pattern in `.ai/TEST-FIXTURES.md` §1 matches the
  implemented `cause` dual-field contract. (scaleway is the lone connector
  that additionally surfaces the parsed seconds in `providerMessage` —
  documented there as connector-specific.)

---

## Footer

This is a dated snapshot. Updates create a new dated file
(`audits/retry-after-coverage-<YYYY-MM-DD>.md`); existing dated files are
never edited or deleted. The assertion conventions this matrix anchors live
in [`.ai/TEST-FIXTURES.md`](../.ai/TEST-FIXTURES.md) (moved there from the
former `audits/conventions.md`).
