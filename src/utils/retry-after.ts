/**
 * Parses an HTTP `Retry-After` header into seconds.
 *
 * Accepts either an integer-seconds form (`"30"`) or RFC 7231 HTTP-date
 * (`"Fri, 31 Dec 1999 23:59:59 GMT"`). Returns `null` for unparseable input
 * (including a negative integer-seconds value); an HTTP-date in the past
 * clamps to `0` rather than `null`.
 */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const deltaSeconds = Math.ceil((dateMs - Date.now()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : 0;
}
