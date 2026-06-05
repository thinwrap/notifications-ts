# @thinwrap/notifications

Unified TypeScript facade for 35 notification providers across email, SMS, push, and chat.
Stateless. Zero vendor SDKs. Bring your own `fetch`.

## Install

```bash
npm install @thinwrap/notifications
```

Requires Node.js ≥18 (uses native `fetch`).

## End-to-end example

```typescript
import { Email, ConnectorError } from '@thinwrap/notifications';

const sendgrid = new Email('sendgrid', {
  apiKey: process.env.SENDGRID_KEY!,
  from: 'noreply@example.com',
});

try {
  const result = await sendgrid.send({
    to: 'user@example.com',
    subject: 'Hello from @thinwrap/notifications',
    html: '<p>It works.</p>',
  });
  console.log(result.success, result.providerMessageId);
} catch (e) {
  if (e instanceof ConnectorError) {
    console.error(e.providerCode, e.providerMessage);
  } else throw e;
}
```

## Switching providers

Change the provider ID and config; everything else stays.

```typescript
const mailgun = new Email('mailgun', {
  apiKey: process.env.MAILGUN_KEY!,
  domain: 'mg.example.com',
  from: 'noreply@example.com',
});

await mailgun.send({ to: 'user@example.com', subject: 'Hi', text: 'It works.' });
```

## Bring your own `fetch`

```typescript
import { Email } from '@thinwrap/notifications';
import undici from 'undici';

const email = new Email('sendgrid', {
  apiKey: process.env.SENDGRID_KEY!,
  from: 'noreply@example.com',
  fetch: undici.fetch,           // any fetch-compatible function
});
```

The wrapper holds no state — no token cache, no connection pool, no retry buffer.
FCM and APNs sign tokens fresh on every `.send()` by default; supply an optional
`tokenCache?: TokenCacheHook` in config to amortize signing cost. See the
[FCM](src/providers/fcm/README.md) and [APNs](src/providers/apns/README.md) READMEs
for hook-shape detail.

## Error handling

```typescript
import { ConnectorError } from '@thinwrap/notifications';

try {
  await sendgrid.send(input);
} catch (e) {
  if (e instanceof ConnectorError) {
    switch (e.providerCode) {
      case 'rate_limited':         /* respect Retry-After in e.cause     */ break;
      case 'auth_failed':          /* rotate credentials                  */ break;
      case 'invalid_request':      /* fix payload                         */ break;
      case 'invalid_recipient':    /* clean address                       */ break;
      case 'provider_unavailable': /* transient 5xx — your retry strategy */ break;
      case 'unknown':              /* fallback                            */ break;
    }
  } else throw e;
}
```

The wrapper performs no automatic retry. Compose your own retry strategy from
`providerCode` and the raw vendor response carried on `e.cause` (including the
`Retry-After` header where the vendor sets one).

## `_passthrough` escape valve

When the normalized input doesn't expose a vendor-specific field, forward arbitrary
keys via `_passthrough`:

```typescript
await sendgrid.send({
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>fallback</p>',
  _passthrough: {
    body: { dynamic_template_data: { name: 'Alice', orderId: '12345' } },
    headers: { 'X-Custom-Header': 'value' },
  },
});
```

Keys are forwarded verbatim — no casing transformation. See each per-connector
README for vendor-specific `_passthrough` examples.

## Bring your own connector

When `_passthrough` isn't enough — the provider isn't shipped at all — implement the
channel's exported connector interface (`IEmailConnector` / `ISmsConnector` /
`IPushConnector` / `IChatConnector`) and pass the instance to the facade constructor.
The contract is `id`, `channelType`, and `send()`. You keep the normalized input/result
shapes and the uniform error-handling path; only the wire call is yours.

```typescript
import { Push, ChannelTypeEnum } from '@thinwrap/notifications';
import type { IPushConnector, PushSendInput, PushSendResult } from '@thinwrap/notifications';

class NtfyPushConnector implements IPushConnector {
  readonly id = 'ntfy';
  readonly channelType = ChannelTypeEnum.PUSH;

  async send(input: PushSendInput): Promise<PushSendResult> {
    const res = await fetch(`https://ntfy.sh/${input.to}`, {
      method: 'POST',
      headers: input.title ? { Title: input.title } : undefined,
      body: input.body ?? '',
    });
    return {
      success: res.ok,
      status: res.ok ? 'sent' : 'rejected',
      providerMessageId: null,
      raw: await res.json(),
    };
  }
}

const push = new Push(new NtfyPushConnector());
await push.send({ to: 'deploys', title: 'Deploy', body: 'v1.0 is live' });
```

Throw `ConnectorError` from `send()` for hard failures so consumers keep a single
error-handling path; return `success: false` for HTTP-2xx-but-rejected soft-rejects,
matching the built-in connectors.

## Language constraints

- Node.js ≥18 required (uses native `fetch`).
- Node 18, 19, and 20 emit an `ExperimentalWarning: The Fetch API is an experimental feature`
  on first `fetch` use. This is an upstream Node disclosure, not a `@thinwrap/notifications`
  warning — fetch became stable (warning removed) in [Node 21.0](https://github.com/nodejs/node/pull/45684).
  fetch is functionally identical across Node 18–26 for Thinwrap's GET/POST/JSON usage.
  Set `NODE_NO_WARNINGS=1` or use `--no-warnings` to suppress on 18/19/20, or upgrade to Node 21+.
- Ships dual-build: ESM (`import`) and CJS (`require`). Full TypeScript types.
- Zero runtime dependencies. AWS Signature V4 (SES + SNS connectors) is
  hand-rolled against `node:crypto`. No vendor SDKs.
- Server-only. Browser support is not in v1.0 — most providers require server-only
  secrets.

## Per-connector documentation

Each per-connector README documents auth method, regional/sandbox endpoints, narrowed
input augmentations, outlier translations, error-code mappings, and `_passthrough`
examples.

### Email (10)

| Provider | README |
|---|---|
| `ses`        | [src/providers/ses/README.md](src/providers/ses/README.md) |
| `resend`     | [src/providers/resend/README.md](src/providers/resend/README.md) |
| `mailgun`    | [src/providers/mailgun/README.md](src/providers/mailgun/README.md) |
| `sendgrid`   | [src/providers/sendgrid/README.md](src/providers/sendgrid/README.md) |
| `postmark`   | [src/providers/postmark/README.md](src/providers/postmark/README.md) |
| `mailersend` | [src/providers/mailersend/README.md](src/providers/mailersend/README.md) |
| `mailtrap`   | [src/providers/mailtrap/README.md](src/providers/mailtrap/README.md) |
| `brevo`      | [src/providers/brevo/README.md](src/providers/brevo/README.md) |
| `sparkpost`  | [src/providers/sparkpost/README.md](src/providers/sparkpost/README.md) |
| `scaleway`   | [src/providers/scaleway/README.md](src/providers/scaleway/README.md) |

### SMS (10)

| Provider | README |
|---|---|
| `nexmo` (Vonage) | [src/providers/vonage/README.md](src/providers/vonage/README.md) |
| `twilio`         | [src/providers/twilio/README.md](src/providers/twilio/README.md) |
| `plivo`          | [src/providers/plivo/README.md](src/providers/plivo/README.md) |
| `sns`            | [src/providers/sns/README.md](src/providers/sns/README.md) |
| `sinch`          | [src/providers/sinch/README.md](src/providers/sinch/README.md) |
| `telnyx`         | [src/providers/telnyx/README.md](src/providers/telnyx/README.md) |
| `infobip`        | [src/providers/infobip/README.md](src/providers/infobip/README.md) |
| `messagebird`    | [src/providers/messagebird/README.md](src/providers/messagebird/README.md) |
| `textmagic`      | [src/providers/textmagic/README.md](src/providers/textmagic/README.md) |
| `d7networks`     | [src/providers/d7networks/README.md](src/providers/d7networks/README.md) |

### Push (6)

| Provider | README |
|---|---|
| `fcm`          | [src/providers/fcm/README.md](src/providers/fcm/README.md) |
| `expo`         | [src/providers/expo/README.md](src/providers/expo/README.md) |
| `apns`         | [src/providers/apns/README.md](src/providers/apns/README.md) |
| `one-signal`   | [src/providers/one-signal/README.md](src/providers/one-signal/README.md) |
| `pusher-beams` | [src/providers/pusher-beams/README.md](src/providers/pusher-beams/README.md) |
| `wonderpush`   | [src/providers/wonderpush/README.md](src/providers/wonderpush/README.md) |

### Chat (9)

| Provider | README |
|---|---|
| `telegram`          | [src/providers/telegram/README.md](src/providers/telegram/README.md) |
| `slack`             | [src/providers/slack/README.md](src/providers/slack/README.md) |
| `whatsapp-business` | [src/providers/whatsapp-business/README.md](src/providers/whatsapp-business/README.md) |
| `discord`           | [src/providers/discord/README.md](src/providers/discord/README.md) |
| `ms-teams`          | [src/providers/ms-teams/README.md](src/providers/ms-teams/README.md) |
| `google-chat`       | [src/providers/google-chat/README.md](src/providers/google-chat/README.md) |
| `mattermost`        | [src/providers/mattermost/README.md](src/providers/mattermost/README.md) |
| `rocket-chat`       | [src/providers/rocket-chat/README.md](src/providers/rocket-chat/README.md) |
| `line`              | [src/providers/line/README.md](src/providers/line/README.md) |

## Migrating

### From a vendor SDK

Replace SDK construction with the facade; replace SDK method calls with `.send(...)`:

```typescript
// Before — @sendgrid/mail
import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_KEY!);
await sgMail.send({ to, from, subject, html });

// After
import { Email } from '@thinwrap/notifications';
const email = new Email('sendgrid', { apiKey: process.env.SENDGRID_KEY!, from });
await email.send({ to, subject, html });
```

### From `@novu/providers`

The connector classes are shape-compatible with Novu's provider interfaces
(`IEmailProvider`, `ISmsProvider`, `IPushProvider`, `IChatProvider`). You can use the
facade or instantiate the connector class directly:

```typescript
// Before
import { SendgridEmailProvider } from '@novu/providers';
const sg = new SendgridEmailProvider({ apiKey, from });

// After
import { Email } from '@thinwrap/notifications';
const sg = new Email('sendgrid', { apiKey, from });
```

See [MIGRATION.md](./MIGRATION.md) for the full recipe (sed-across-codebase,
return-shape delta, edge cases).

### From raw HTTP

If you've been hand-rolling vendor HTTP calls, the facade collapses the boilerplate
to one line per send. Error handling and retry composition stay yours.

## For AI agents and contributors

- [`.ai/guidelines.md`](.ai/guidelines.md) — usage contract.
- [`.ai/ARCHITECTURE.md`](.ai/ARCHITECTURE.md) — facade-dispatch-base pattern.
- [`.ai/CONVENTIONS.md`](.ai/CONVENTIONS.md) — naming, file layout, test patterns.

## License

MIT — see [LICENSE](LICENSE).
