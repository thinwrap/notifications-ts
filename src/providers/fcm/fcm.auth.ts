import crypto from 'crypto';
import { ConnectorError } from '../../utils';
import type { GoogleTokenResponse } from './fcm.types';

/**
 * Sign an RS256 JWT for Google's OAuth 2.0 service-account flow using only
 * Node's `node:crypto` stdlib — no third-party crypto dependency.
 *
 * Claims:
 *   iss   = service-account client_email
 *   scope = https://www.googleapis.com/auth/firebase.messaging
 *   aud   = https://oauth2.googleapis.com/token
 *   iat   = now (seconds since epoch)
 *   exp   = now + 3600
 */
export function createSignedJwt(clientEmail: string, privateKey: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');

  const unsignedToken = `${encodedHeader}.${encodedClaims}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsignedToken);
  sign.end();

  const signature = sign.sign(privateKey, 'base64url');

  return `${unsignedToken}.${signature}`;
}

/**
 * Stateless service-account → access-token exchange.
 * Because the wrapper holds no state, this function takes no cache argument
 * and produces no cache state — it signs a fresh JWT and exchanges it at
 * Google's OAuth2 endpoint every call. Consumer-facing memoization is wired
 * through `FcmConfig.tokenCache` on the connector itself.
 *
 * Returns absolute `expiresInSeconds` from Google's response (typically 3599).
 * The caller is responsible for converting to epoch-ms before storing in a
 * `TokenCacheHook` (key = `'fcm:' + projectId`).
 */
export async function getAccessToken(
  clientEmail: string,
  privateKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const jwt = createSignedJwt(clientEmail, privateKey);

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new ConnectorError({
      message: `FCM OAuth token exchange failed: ${response.status} ${errText}`,
      statusCode: response.status,
      providerCode: 'auth_failed',
      providerMessage: errText || `FCM OAuth token exchange failed: ${response.status}`,
    });
  }

  const data = (await response.json()) as GoogleTokenResponse;

  return {
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in,
  };
}
