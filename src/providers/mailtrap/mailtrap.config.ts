export interface MailtrapConfig {
  /**
   * Mailtrap API token used as the Bearer credential.
   */
  apiToken: string;
  /**
   * REQUIRED — explicit, no default. Determines the API endpoint used by `.send()`:
   *   - `'sandbox'`     → `https://sandbox.api.mailtrap.io/api/send/<inboxId>`
   *   - `'production'`  → `https://send.api.mailtrap.io/api/send`
   *
   * No default is provided because the failure mode is asymmetric: a production
   * email accidentally routed to the sandbox is a quiet bug; a sandbox email
   * accidentally hitting production is a real-user-impact bug. Consumers must
   * pick deliberately.
   */
  mode: 'sandbox' | 'production';
  /**
   * REQUIRED when `mode === 'sandbox'`; FORBIDDEN when `mode === 'production'`.
   * Validated synchronously at construction time — misconfigurations throw a
   * `ConnectorError` before the first `.send()` call.
   */
  inboxId?: string;
  from: string;
  senderName?: string;
  fetch?: typeof fetch;
}
