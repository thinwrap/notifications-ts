# `@thinwrap/notifications` — Architecture

One-page summary of the facade-dispatch-base pattern as it manifests in this package.

## Why facade + dispatch + base

Three layers. Consumer constructs a channel facade by provider ID; the facade dispatches
to a specific connector class; the connector extends `BaseConnector`, which centralizes
HTTP + JSON parsing + error mapping. No global middleware.

```
Consumer code
    │  new Email('sendgrid', cfg)
    ▼
Email facade ──── lookup ────► SendgridEmailConnector
    │  .send(input)                │  extends BaseConnector
    ▼                              ▼
connector.send(input)        BaseConnector.post(url, body, headers)
                                   │
                                   ▼  fetch (BYO or globalThis.fetch)
                              Vendor API
```

## `id` + channel introspection

Each facade and connector exposes `connector.id` (the provider-ID string literal — e.g.
`'sendgrid'`, `'twilio'`) for runtime introspection without breaking the facade abstraction.
Channel is implicit from the facade class (`Email`, `Sms`, `Push`, `Chat`).

## Baseline coverage discipline (≥90% rule)

The normalized facade input/output shape
includes only features ≥90% of providers in that channel natively support. Sub-90%
features go to `_passthrough` (input) or `raw` (output). Concretely: `subject` is on
the email facade because every email vendor supports it; SendGrid `categories` is not,
because most don't — that goes through `_passthrough.body.categories`.

## Architectural-outlier exception

Three single-provider misses get translated at the wire layer **inside the connector**,
not bubbled up to facades:

- **Pusher Beams** synthesizes `aps` + `notification` payloads from base push input.
- **SparkPost** translates CC/BCC into `recipients[].header_to` + `content.headers.CC`.
- **Brevo** throws `invalid_request` on attachment `contentId` (vendor doesn't support).

These do not disqualify a field from baseline. Translation stays local.

## Per-connector locality

`mapVendorError`, casing transforms (`CasingEnum.SNAKE_CASE`, `CasingEnum.CAMEL_CASE`,
`CasingEnum.PASCAL_CASE` from `src/base/casing-transform.ts`), and outlier translations
live inside each `src/providers/<id>/` directory. No global middleware. `BaseConnector`
applies no automatic key transformation — connectors call `transformKeys(...)` explicitly
when they need it. The earlier `BaseProvider` shim that did automatic
casing-on-extend was removed in the v1.0 hardening pass.

## Stateless wrapper + optional `TokenCacheHook`

The wrapper holds no token state. FCM and APNs sign fresh on every `.send()` by default. Consumers wanting to
amortize signing cost pass `tokenCache: TokenCacheHook` in config; the wrapper memoizes
through the hook with deterministic keys — `'fcm:' + projectId` for FCM,
`'apns:' + teamId + ':' + keyId + ':' + bundleId` for APNs. On vendor 401/403 the wrapper
does **not** auto-evict; eviction is the consumer's responsibility. See
[`../src/providers/fcm/README.md`](../src/providers/fcm/README.md) and
[`../src/providers/apns/README.md`](../src/providers/apns/README.md) for hook-shape detail.

No retries, no idempotency-key generation, no in-wrapper telemetry.

## Cross-reference

- Naming, file layout, test patterns: [`./CONVENTIONS.md`](./CONVENTIONS.md)
- Adding a connector / contributor entry point: [`./guidelines.md`](./guidelines.md)
- Consumer usage (install, send, error handling): [`../README.md`](../README.md)
