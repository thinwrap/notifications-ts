# FCM Push Connector

## Quick install

See the [package README](../../../README.md). Dispatches when
`providerId === 'fcm'`.

## Configuration

```typescript
import { Push } from '@thinwrap/notifications';
import type { TokenCacheHook } from '@thinwrap/notifications';

const fcm = new Push('fcm', {
  projectId: 'my-firebase-project',
  clientEmail: 'sa@my-firebase-project.iam.gserviceaccount.com',
  privateKey: process.env.FCM_PRIVATE_KEY!,        // PEM RSA private key
  tokenCache: myCacheImpl,                          // optional — see below
});
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `projectId` | `string` | yes | Firebase project ID |
| `clientEmail` | `string` | yes | Service-account `client_email` |
| `privateKey` | `string` | yes | PEM-encoded `private_key` from service-account JSON |
| `tokenCache` | `TokenCacheHook` | no | Consumer-provided cache for the OAuth access token |

## Auth setup

Three-step auth: connector signs an RS256 JWT with the service-account private
key, exchanges it for a short-lived OAuth2 access token at
`https://oauth2.googleapis.com/token`, then sends the access token as a
Bearer credential to FCM.

By default the wrapper signs + exchanges on every `.send()` (stateless —
the wrapper holds no state). Pass a `tokenCache: TokenCacheHook` to
amortize signing cost across many sends — the wrapper memoizes through the
hook with the deterministic key `'fcm:' + projectId + ':' + clientEmail`. On vendor 401/403 the
wrapper does **not** auto-evict; eviction is the consumer's responsibility.

`TokenCacheHook` shape:

```typescript
interface TokenCacheHook {
  get(key: string): Promise<{ token: string; expiresAt: number } | null>;
  set(key: string, token: string, expiresAt: number): Promise<void>;
}
```

## Endpoint

`POST https://fcm.googleapis.com/v1/projects/<projectId>/messages:send`.

## Narrowed input augmentations

Standard push input (`to`, `title`, `body`, `data` — the 4-field baseline).
FCM-narrowed: `ttl` (folds into `android.ttl` as `"<n>s"`).
Platform-specific payload (`android`, `apns`, `webpush`), topic/condition
targeting, and `fcm_options` via `_passthrough.body`.

## Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 / 403 (token rejected) | `auth_failed` |
| 404 `UNREGISTERED` token | `invalid_recipient` |
| 400 `INVALID_ARGUMENT` | `invalid_request` |
| 429 / `QUOTA_EXCEEDED` | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `unknown` |

## `_passthrough` examples

Topic send + Android-specific config:

```typescript
await fcm.send({
  to: 'dummy',                          // unused for topic send
  title: 'Breaking news',
  body: 'Read more in the app.',
  _passthrough: {
    body: {
      topic: 'breaking-news',
      android: { priority: 'high', notification: { sound: 'default' } },
      apns: { headers: { 'apns-priority': '10' } },
    },
  },
});
```

## Vendor docs

- API reference: https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send
- OAuth2 auth: https://firebase.google.com/docs/cloud-messaging/auth-server
- Error codes: https://firebase.google.com/docs/cloud-messaging/error-codes
