# `@thinwrap/notifications` — contributor guide

This folder (`.ai/`) is for developers — and the coding agents working alongside them — who are
**changing this library**: adding a connector or improving the package. It is not usage
documentation.

> **Using the package in your app?** See [`../README.md`](../README.md) and the per-connector
> READMEs under [`../src/providers/`](../src/providers). `.ai/` is not part of the npm tarball —
> its only audience is people working in the repo.

## Map of this folder

- **guidelines.md** (this file) — entry point + the "add a connector" recipe.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the facade → dispatch → base model and the invariants every change must hold.
- [`CONVENTIONS.md`](./CONVENTIONS.md) — file layout, naming, TypeScript/build config, the per-connector README frontmatter.
- [`TEST-FIXTURES.md`](./TEST-FIXTURES.md) — shared spec fixtures (`Retry-After`, `TokenCacheHook`).

## The shape in one sentence

A consumer constructs a channel facade by provider id (`new Email('sendgrid', cfg)`); the facade
dispatches to a connector class under `src/providers/<id>/` that extends `BaseConnector`, which
centralizes `fetch` + JSON parsing + error mapping. No global middleware — vendor specifics stay
local to the connector.

## Setup & verify

```bash
npm install
npm run typecheck && npm test
```

Node ≥18 (native `fetch`). **Zero runtime dependencies — do not add any** (SigV4 for SES/SNS is
hand-rolled on `node:crypto`).

## Add a connector

Copy an existing connector as your template — [`src/providers/sendgrid/`](../src/providers/sendgrid)
for a plain API-key email connector, [`src/providers/fcm/`](../src/providers/fcm) when token signing
is involved. Touch-points, in order:

1. **Register the id** — add the case to the channel enum in [`src/types/provider-id.enum.ts`](../src/types/provider-id.enum.ts). A compile-time assertion keeps the enum in sync; `typecheck` fails if it drifts.
2. **Wire the config map** — add `'<id>': <Name>Config` to [`src/types/config-map.type.ts`](../src/types/config-map.type.ts) and add the id to that channel's provider union.
3. **Narrow input only if needed** — if the provider exposes fields the base channel input doesn't, add the mapping to [`src/types/input-map.type.ts`](../src/types/input-map.type.ts). Otherwise skip it (see the ≥90% rule below).
4. **Create `src/providers/<id>/`**:
   - `<id>.config.ts` — `<Name>Config` interface (auth fields first, optional `fetch?`).
   - `<id>.connector.ts` — class `extends BaseConnector`, `readonly id`, `send(...)`, private `mapVendorError(...)`.
   - `<id>.connector.spec.ts` — vitest; inject a `vi.fn()` fetch mock (see CONVENTIONS / TEST-FIXTURES).
   - `<id>.types.ts` — only when narrowing.
   - `<id>.auth.ts` — only for non-trivial token lifecycle (FCM, APNs).
   - `index.ts` — barrel re-export.
   - `README.md` — YAML frontmatter (schema: [`../schemas/connector-readme-schema.yaml`](../schemas/connector-readme-schema.yaml)) + body. **This** is the connector's consumer doc.
5. **Dispatch** — add the case to `src/facades/<channel>.facade.ts`.
6. **Export** — re-export the connector + config from [`src/index.ts`](../src/index.ts), the only public surface.
7. **Budget** — register the connector in the bundle-size budget so `npm run size` covers it.

### Definition of done (the CI gates)

```bash
npm run typecheck        # strict; enum / config-map sync
npm test                 # vitest — single file: npx vitest src/providers/<id>/<id>.connector.spec.ts
npm run lint
npm run lint:frontmatter # validates every connector README against the schema
npm run build && npm run check:dist   # dual CJS/ESM emit + import smoke
npm run size             # per-connector gzip budget
```

CI runs these across a Node 18/20/22 × Linux/macOS/Windows matrix, plus an offline (network-disabled)
import smoke that proves zero import-time egress.

## Invariants you must not break

Full reasoning lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md); the short list:

- **Zero runtime deps / no vendor SDKs.** The bundle budgets depend on it.
- **Stateless wrapper.** No caching, retries, idempotency keys, or telemetry inside the wrapper. FCM/APNs sign fresh unless the consumer passes a `tokenCache` hook.
- **≥90% baseline-coverage rule.** A field belongs on the base channel input only if ≥90% of that channel's providers support it; everything else goes to `_passthrough` (input) / `raw` (output) or a narrowed type. Don't widen the facade for one vendor.
- **Per-connector locality.** `mapVendorError`, casing transforms, and any wire-layer outlier translation live inside `src/providers/<id>/` — never in `BaseConnector`.
- **Six `ProviderCode` values**, surfaced via `ConnectorError`; the raw `Retry-After` rides in `e.cause`.
- **Pinned `vite ^6` / `vitest ^3` — do not bump** (Node 18 floor).
