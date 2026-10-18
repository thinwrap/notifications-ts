import crypto from 'crypto';
import { ConnectorError } from '../../utils';
import type { ProviderCode } from '../../types';
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

  let signature: string;
  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsignedToken);
    sign.end();
    signature = sign.sign(privateKey, 'base64url');
  } catch (err) {
    // A malformed or wrong-type PEM makes node:crypto throw its own Error.
    // It is a credential problem, so surface it as auth_failed like every
    // other failure; only the class name is kept so no key material or
    // OpenSSL detail about the key can reach a log.
    throw new ConnectorError({
      message: 'FCM service-account privateKey could not sign the OAuth assertion',
      statusCode: null,
      providerCode: 'auth_failed',
      providerMessage: 'FCM service-account privateKey could not sign the OAuth assertion',
      cause: { raw: { exception: (err as Error)?.name ?? 'Error' } },
    });
  }

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

  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if ((error as Error)?.name === 'AbortError') {
      throw new ConnectorError({
        message: (error as Error).message ?? 'Request cancelled',
        statusCode: null,
        providerCode: 'invalid_request',
        cause: error,
      });
    }
    throw new ConnectorError({
      message: (error as Error).message ?? 'Network error',
      statusCode: null,
      providerCode: 'provider_unavailable',
      cause: { raw: error },
    });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new ConnectorError({
      message: `FCM OAuth token exchange failed: ${response.status} ${errText}`,
      statusCode: response.status,
      providerCode: mapOAuthStatus(response.status),
      providerMessage: errText || `FCM OAuth token exchange failed: ${response.status}`,
    });
  }

  // A 200 with a non-JSON or token-less body must NOT flow through as
  // `Bearer undefined` on the next request — validate the token is a non-empty
  // string and surface a typed auth_failed otherwise.
  const data = (await response.json().catch(() => null)) as GoogleTokenResponse | null;
  if (!data || typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new ConnectorError({
      message: 'FCM OAuth token exchange returned a 200 with no usable access_token',
      statusCode: response.status,
      providerCode: 'auth_failed',
      providerMessage: 'FCM OAuth token exchange returned no access_token',
    });
  }

  return {
    accessToken: data.access_token,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : 0,
  };
}

/**
 * Google's token endpoint answers a bad assertion or client with 400/401
 * (`invalid_grant`, `invalid_client`); only those are credential failures.
 * A 429 or 5xx is the endpoint itself being busy or down, and retrying the
 * same credentials can succeed.
 */
function mapOAuthStatus(status: number): ProviderCode {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'auth_failed';
}
