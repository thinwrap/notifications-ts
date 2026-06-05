# `@thinwrap/notifications` — AI agent guide

This file is the canonical entry point for AI agents producing consumer code that uses
`@thinwrap/notifications`. For architecture details see [`./ARCHITECTURE.md`](./ARCHITECTURE.md);
for naming and file-layout rules see [`./CONVENTIONS.md`](./CONVENTIONS.md).

## Install

```bash
npm install @thinwrap/notifications
```

Node ≥18 (uses native `fetch`). No vendor SDKs.

## Facade construction per channel

One pattern per channel — `new Channel(<providerId>, config)`. Every connector exposes
`connector.id` (the provider-ID string) for runtime introspection.

```typescript
import { Email, Sms, Push, Chat } from '@thinwrap/notifications';

const email = new Email('sendgrid', { apiKey: process.env.SENDGRID_KEY!, from: 'noreply@example.com' });
const sms   = new Sms('twilio',   { accountSid: 'AC…', authToken: '…', from: '+14155550100' });
const push  = new Push('fcm',     { projectId: 'p', clientEmail: 'sa@p.iam.gserviceaccount.com', privateKey: '-----BEGIN PRIVATE KEY-----…' });
const chat  = new Chat('slack',   { webhookUrl: 'https://hooks.slack.com/services/T/B/X' });
```

Provider-ID string literals are fully typed (typos fail to compile). Prefer-enum codebases
can use the equivalent `EmailProviderIdEnum` / `SmsProviderIdEnum` / `PushProviderIdEnum` /
`ChatProviderIdEnum` exports interchangeably — `new Email(EmailProviderIdEnum.Sendgrid, …)`.
Enum values are compile-time-asserted to stay in sync with the provider-ID unions.

## Switching providers

Swap the provider ID; the input shape passed to `.send(...)` does not change.

```typescript
const a = new Email('sendgrid', { apiKey, from });
const b = new Email('postmark', { serverToken, from });
// .send({ to, subject, html }) is identical for both
```

## BYO `fetch`

Inject any fetch-compatible function. The wrapper holds no state — no token cache, no
connection pool, no retry buffer (the wrapper holds no state). FCM and APNs
sign tokens fresh on every `.send()` by default; supply optional `tokenCache?: TokenCacheHook`
in config to amortize signing cost (see [`../src/providers/fcm/README.md`](../src/providers/fcm/README.md)
and [`../src/providers/apns/README.md`](../src/providers/apns/README.md)).

```typescript
import undici from 'undici';
const email = new Email('sendgrid', { apiKey, from, fetch: undici.fetch });
```

## `_passthrough` escape valve

Forward arbitrary vendor-specific fields without casing transformation.

```typescript
await email.send({
  to: 'user@example.com', subject: 'Hi', html: '<p>Hi</p>',
  _passthrough: { body: { dynamic_template_data: { name: 'Alice' } } },
});
```

## Error handling

One class, one switch. The wrapper performs no automatic retry — compose your own from
`providerCode` and `e.cause` (which carries the raw `Retry-After` header when present).

```typescript
import { ConnectorError } from '@thinwrap/notifications';

try {
  await email.send(input);
} catch (e) {
  if (e instanceof ConnectorError) {
    switch (e.providerCode) {
      case 'rate_limited':        /* respect Retry-After in e.cause */ break;
      case 'auth_failed':         /* rotate credentials              */ break;
      case 'invalid_request':     /* fix payload                     */ break;
      case 'invalid_recipient':   /* clean address                   */ break;
      case 'provider_unavailable':/* transient 5xx — your retry      */ break;
      case 'unknown':             /* fallback                        */ break;
    }
  } else throw e;
}
```

`ProviderCode` is the union `'rate_limited' | 'auth_failed' | 'invalid_request' | 'invalid_recipient' | 'provider_unavailable' | 'unknown'`.

## Novu drop-in (TypeScript only)

The per-channel facades and the connectors they dispatch to are shape-compatible with Novu's
`IEmailProvider` / `ISmsProvider` / `IPushProvider` / `IChatProvider`. See the channel-input
table below for the per-channel input shape; per-provider augmentations live in each
connector's README.

## Per-channel input shape — navigation index

This table is a navigation aid, not a comparison matrix. Provider-specific fields
(`cc`, `bcc`, `categories`, regional endpoints, attachment encoding, error mappings) live
in per-connector READMEs.

| Channel | See per-connector README (example) |
|---|---|
| Email | [`sendgrid`](../src/providers/sendgrid/README.md) |
| SMS   | [`twilio`](../src/providers/twilio/README.md) |
| Push  | [`fcm`](../src/providers/fcm/README.md) |
| Chat  | [`slack`](../src/providers/slack/README.md) |

See [`./ARCHITECTURE.md`](./ARCHITECTURE.md) ("Why facade + dispatch + base") for the
dispatch model and [`./CONVENTIONS.md`](./CONVENTIONS.md) ("Where files live in this repo")
for the directory layout.
