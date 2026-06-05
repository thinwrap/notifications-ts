/**
 * Pusher Beams connector configuration.
 *
 * Beams uses a long-lived server-side secret key issued from the Beams
 * dashboard. There is no token signing or refresh — the secret travels
 * verbatim in `Authorization: Bearer <secretKey>` on every `.send()` call.
 * Per the stateless-wrapper design, no token caching applies.
 */
export interface PusherBeamsConfig {
  /** Pusher Beams instance ID (UUID-like, from the Beams dashboard). */
  instanceId: string;
  /** Server-side secret key from the Beams dashboard. */
  secretKey: string;
  /** Bring-your-own fetch implementation BYO-fetch contract. */
  fetch?: typeof fetch;
}
