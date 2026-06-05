export interface MailgunConfig {
  /**
   * Mailgun API key. Used as the Basic-auth password against the username
   * `api` (or `config.username`).
   */
  apiKey: string;
  /**
   * Sending domain (e.g. `mg.example.com`). Forms the URL path
   * `/v3/<domain>/messages`.
   */
  domain: string;
  /** Default sender address. */
  from: string;
  /** Optional display name; merged as `"<senderName> <from>"`. */
  senderName?: string;
  /**
   * Mailgun region. `'us'` (default) routes to `api.mailgun.net`;
   * `'eu'` routes to `api.eu.mailgun.net`. Ignored when `baseUrl` is set.
   */
  region?: 'us' | 'eu';
  /**
   * Basic-auth username; defaults to `'api'`. Override only for self-hosted
   * deployments that require a different username.
   */
  username?: string;
  /**
   * Escape hatch: explicit endpoint base (e.g. `'https://example.local'`).
   * Takes precedence over `region`. Path `/v3/<domain>/messages` is appended.
   */
  baseUrl?: string;
  /** BYO `fetch` for non-Node runtimes / testing. */
  fetch?: typeof fetch;
}
