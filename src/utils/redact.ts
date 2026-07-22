/**
 * Security helpers for scrubbing credentials out of surfaced transport errors.
 *
 * Several connectors carry the credential IN the request URL — webhook-URL-as-auth
 * (Slack, Google Chat, MS Teams, Mattermost, Rocket.Chat, Discord) or a bot token
 * embedded in the path (Telegram). A BYO `fetch` may embed that URL in the `Error`
 * it throws on a DNS/connection failure (e.g. node-fetch's
 * `request to <url> failed`), which would then surface verbatim in
 * `ConnectorError.message` / `cause` and get logged or sent to Sentry. These
 * helpers redact known secrets from the message and reduce the stored cause to a
 * non-sensitive shape.
 */

/**
 * Literal (non-regex) replacement of each secret with `<redacted>`. Undefined /
 * empty secrets are skipped. Uses `split`/`join` rather than a built `RegExp`
 * because webhook URLs are full of regex-special characters.
 */
export function redactSecrets(
  text: string,
  secrets: Array<string | undefined>,
): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('<redacted>');
  }
  return out;
}

/**
 * Reduce an arbitrary thrown transport error to a non-sensitive shape safe to
 * store on `ConnectorError.cause`. Deliberately drops the raw error (its
 * `message`, `stack`, `cause`, and any embedded request URL) — a leaky BYO fetch
 * error can carry the full webhook URL / bot token in those fields. Keeps only
 * the error `name` and (when present) a machine `code` string (e.g.
 * `ECONNREFUSED`).
 */
export function scrubTransportError(
  error: unknown,
): { name?: string; code?: string } {
  const out: { name?: string; code?: string } = {};
  const e = error as { name?: unknown; code?: unknown } | null | undefined;
  if (e && typeof e.name === 'string') out.name = e.name;
  if (e && typeof e.code === 'string') out.code = e.code;
  return out;
}
