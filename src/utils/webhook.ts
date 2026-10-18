import { ConnectorError } from '../types/error.types';

/**
 * Refuse a non-https webhook URL before any request is built. For webhook
 * providers the URL IS the credential, so a stale or typo'd `http://` config
 * would send the token in cleartext.
 */
export function assertHttpsWebhookUrl(url: string, provider: string): void {
  if (/^https:\/\//i.test(url)) return;
  const message = `${provider} webhookUrl must be an https:// URL.`;
  throw new ConnectorError({
    message,
    statusCode: 400,
    providerCode: 'invalid_request',
    providerMessage: message,
  });
}
