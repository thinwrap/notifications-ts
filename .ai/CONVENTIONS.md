# `@thinwrap/notifications` — Conventions

Naming, file layout, and test patterns for AI agents adding a connector or refactoring an
existing one.

Each provider's per-connector `README.md` is plain Markdown — it opens directly with its
`# Title` (no YAML metadata block). It is the connector's consumer-facing doc; keep it
complete and at parity with the sibling-language libraries.

## Where files live in this repo

```
src/
  index.ts                       # public-API barrel
  base/                          # BaseConnector + casing transforms
  facades/                       # Email/Sms/Push/Chat facades + their *.spec.ts
  providers/<id>/                # one directory per connector (canonical path)
    index.ts                     # re-exports
    <id>.connector.ts            # connector class extending BaseConnector
    <id>.connector.spec.ts       # vitest spec — co-located, never in a top-level tests/
    <id>.config.ts               # Config interface
    <id>.types.ts                # narrowed input/result types (only when narrower than base)
    <id>.auth.ts                 # optional — only for non-trivial token lifecycle (FCM, APNs)
    README.md                    # per-connector consumer doc (plain Markdown)
  types/                         # cross-channel types + provider-id enums
  utils/                         # passthrough merge + small helpers
```

An earlier path `src/connectors/<id>/` was renamed to `src/providers/<id>/`;
all in-tree references use the canonical path.

## Provider-ID literal types

Provider IDs are TypeScript string-literal enums per channel, declared in
`src/types/provider-id.enum.ts`:

```typescript
export enum EmailProviderIdEnum { SES = 'ses', Sendgrid = 'sendgrid', /* … */ }
export enum SmsProviderIdEnum   { Twilio = 'twilio', Nexmo = 'nexmo', /* … */ }
export enum PushProviderIdEnum  { FCM = 'fcm', APNS = 'apns', /* … */ }
export enum ChatProviderIdEnum  { Slack = 'slack', /* … */ }
```

Adding a connector is a one-line enum extension. No numeric enums. The facade switch in
`src/facades/<channel>.facade.ts` dispatches on these literals.

## File naming

| File | Required? | Purpose |
|---|---|---|
| `<id>.connector.ts` | yes | Connector class extending `BaseConnector` |
| `<id>.connector.spec.ts` | yes | vitest spec, co-located |
| `<id>.config.ts` | yes | Exported `<Name>Config` interface |
| `<id>.types.ts` | when narrower than base | Narrowed input/result types |
| `<id>.auth.ts` | only for non-trivial tokens (FCM, APNs) | Token signing / cache wiring |
| `index.ts` | yes | Barrel re-export |
| `README.md` | yes | Per-connector consumer doc (plain Markdown) |

## Test pattern (vitest)

Mock `globalThis.fetch` via `vi.fn()` and inject via the `fetch` constructor param. No
global module-level mocks of fetch. Spec files share a per-channel fixture shape.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SendgridEmailConnector } from './sendgrid.connector';

describe('SendgridEmailConnector', () => {
  it('POSTs to the v3 mail/send endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('', { status: 202, headers: { 'x-message-id': 'abc' } })
    );
    const sg = new SendgridEmailConnector({ apiKey: 'k', from: 'a@b.c' }, fetchMock);
    await sg.send({ to: 'u@x', subject: 's', html: '<p>h</p>' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

## TypeScript / lint / build

- `tsconfig.json` is `strict: true` with `noUncheckedIndexedAccess`. Target ES2021, lib ES2022.
- ESLint flat config (`eslint.config.mjs`) with `typescript-eslint`. Key rules:
  `consistent-type-imports: error`, `no-explicit-any: warn`.
- `npm run typecheck` (`tsc --noEmit`) clean is the canary AC for any provider rewrite.
- Dual build emits to `dist/cjs/` and `dist/esm/`. Public API surface comes only from
  `src/index.ts`.
- **`vite` is pinned to `^6` and `vitest` to `^3` in devDependencies — do not bump.**
  The CI matrix tests Node 18 (the package's documented runtime floor): Vite 7 and
  Vitest 4 both dropped Node 18 (`engines: ^20…`), and Vite 7 is ESM-only, which
  fails config loading on 18 with `ERR_REQUIRE_ESM`. Revisit only when the runtime
  floor moves to Node 20. (The vitest<4.1 UI-server advisory GHSA-5xrq-8626-4rwp is
  accepted: dev-only, requires `vitest --ui` with a listening server — never used
  here; CI runs `vitest run`.)
