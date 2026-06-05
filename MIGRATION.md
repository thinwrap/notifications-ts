# Migration: `@novu/providers` → `@thinwrap/notifications`

Mechanical migration recipe for consumers moving off `@novu/providers`.
`@thinwrap/notifications` exposes a Novu-shaped `sendMessage(options)` on every
connector (inspiration credit, not a contract — see project notes). The work is
mostly two find-and-replace passes plus return-shape adjustment at call sites
that read result values.

## Import change

```ts
// before
import { SendgridEmailProvider } from '@novu/providers';
const provider = new SendgridEmailProvider({ apiKey });
await provider.sendMessage({ to: ['u@e.com'], subject: 'Hi', html: '<p>Hi</p>' });

// after
import { SendgridEmailConnector } from '@thinwrap/notifications';
const provider = new SendgridEmailConnector({ apiKey });
await provider.sendMessage({ to: ['u@e.com'], subject: 'Hi', html: '<p>Hi</p>' });
```

Sed across a codebase:

```bash
find . -name '*.ts' -not -path './node_modules/*' \
  -exec sed -i.bak 's|@novu/providers|@thinwrap/notifications|g; s|EmailProvider\b|EmailConnector|g; s|SmsProvider\b|SmsConnector|g; s|PushProvider\b|PushConnector|g; s|ChatProvider\b|ChatConnector|g' {} +
```

(`sed -i.bak` works on both macOS BSD sed and GNU sed; delete the `.bak`
files after.)

## Return-shape delta

Novu returned `Promise<ISendMessageSuccessResponse>` (`{ id?, ids?, date? }`).
Thinwrap returns the Novu shape from `sendMessage()` for drop-in compatibility,
but the native `.send(input)` path returns the richer `<Channel>SendResult`
shape (`{ success, status, providerMessageId, raw }`).

For new code, prefer the native path:

```ts
// preferred: Thinwrap-native
const result = await connector.send({ to: 'u@e.com', subject: 'Hi', html: '<p>Hi</p>' });
if (!result.success) { /* soft-reject handling */ }
```

| Novu field | Thinwrap-native field |
|---|---|
| `id` | `providerMessageId` |
| `date` | (none — read from `result.raw` if needed) |
| (new) | `success: boolean` — `false` on soft-reject (HTTP 2xx + vendor body says rejected) |
| (new) | `status: 'sent' \| 'queued' \| 'rejected' \| 'suppressed' \| 'unknown'` |
| (new) | `raw: unknown` — verbatim vendor response |

## Edge cases

- **Multi-recipient (`to: string[]` with length > 1)** on the native `.send()`
  path: single recipient per call. Loop manually if needed. The brownfield
  `sendMessage()` shape still accepts arrays for drop-in compatibility, but
  the vendor wire call only honors the first address on connectors that
  enforce single-recipient.
- **Soft-rejects:** prefer `.send(input)` and check `result.success === false`
  for HTTP-2xx-but-rejected responses (Postmark `ErrorCode`, SparkPost
  `errors[]`, etc.). Novu's shape hid these.
- **Novu fields silently dropped by the wrapper:** `senderName`, `customData`,
  `payloadDetails`, `ipPoolName`, `subscriber`, `step`, `payload`, `blocks`,
  `webhookUrl`, most of `overrides.*`. Use `.send(input)` with
  `_passthrough.body` for vendor-specific data.
- **Removed surfaces:** `getMessageId` and `parseEventBody` are not
  implemented. Remove call sites. `checkIntegration()` IS available on all
  four facades — best-effort: it delegates to the connector when the
  connector implements it (currently SES only) and otherwise resolves
  `{ success: true }` without a network call.
- **Provider IDs:** mostly match Novu enums. Four deliberate divergences —
  see per-connector README `novuProviderId` frontmatter for the canonical
  mapping:
    - `brevo` (Novu calls it `sendinblue`)
    - `infobip` (Novu calls it `infobip-sms`)
    - `ms-teams` (Novu calls it `msteams`) — note the hyphen
    - `rocket-chat` (Novu calls it `rocketchat`) — note the hyphen
  The `nexmo` alias was removed at v1.0; use `vonage` (Vonage rebranded
  from Nexmo in 2019).
- **Dropped push providers:** `pushover`, `ntfy`, and `pushbullet` are not
  shipped at v1.0 — they fell below the baseline-coverage threshold (≥90% of
  push providers must support a given feature for it to be normalized).
  If your code uses any of these, write a custom connector: implement the
  exported `IPushConnector` interface (`id`, `channelType`, `send()`) and
  pass the instance straight to the facade — `new Push(myConnector)`. You
  keep the unified `.send(input)` surface; only the vendor call is yours.
  See [README § Bring your own connector](README.md#bring-your-own-connector)
  for a worked `ntfy` example.
