export interface SparkPostConfig {
  /** SparkPost API key (sent verbatim in `Authorization` header — no `Bearer` prefix). */
  apiKey: string;
  /** Default `from` address. */
  from: string;
  /** Optional sender name applied alongside `from`. */
  senderName?: string;
  /**
   * SparkPost region. `'us'` (default) routes to `https://api.sparkpost.com`;
   * `'eu'` routes to `https://api.eu.sparkpost.com`.
   */
  region?: 'us' | 'eu';
  /** BYO fetch hook — defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}
