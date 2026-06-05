import crypto from 'crypto';

/**
 * Sign an ES256 JWT for APNs token-based authentication using only Node's
 * `node:crypto` stdlib — no third-party crypto dependency.
 *
 * Header: `{ alg: 'ES256', kid: <keyId>, typ: 'JWT' }`
 * Claims: `{ iss: <teamId>, iat: <now-seconds> }`
 *   (No `exp` — APNs validates the JWT against its own ~60-minute tolerance.)
 *
 * `dsaEncoding: 'ieee-p1363'` is critical: Node's default `'der'` produces an
 * ASN.1 `SEQUENCE(INTEGER r, INTEGER s)` signature, which APNs (and the
 * JWT ES256 spec) reject. IEEE P1363 raw `r||s` is required.
 *
 * Per the stateless-wrapper design (2026-05-13 reversal),
 * this is a pure stateless function. No cache parameters, no instance state.
 * Consumer-facing memoization lives in `ApnsConfig.tokenCache` and is wired
 * through the connector itself.
 */
export function createApnsJwt(
  keyId: string,
  teamId: string,
  privateKey: string,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
  ).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({ iss: teamId, iat: now }),
  ).toString('base64url');

  const unsignedToken = `${header}.${claims}`;

  const signature = crypto.sign('SHA256', Buffer.from(unsignedToken), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  return `${unsignedToken}.${signature.toString('base64url')}`;
}
