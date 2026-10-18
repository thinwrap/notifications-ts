import { ConnectorError } from '../types/error.types';

/**
 * Escape a config value for use as ONE URL path segment. Without it a value
 * containing `/`, `?` or `#` (e.g. a pasted ID with a trailing path) would
 * re-route the credentialed request within the vendor host. `:` and `@` stay
 * literal — both are legal in a path segment (RFC 3986 `pchar`) and Telegram
 * bot tokens contain `:`.
 *
 * `''`, `.` and `..` are rejected rather than escaped: the WHATWG URL parser
 * collapses dot-segments (even `%2e`), and an empty segment silently changes
 * the path.
 */
export function encodePathSegment(value: unknown, field: string): string {
  const segment = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (segment === '' || segment === '.' || segment === '..') {
    const message = `${field} must be a non-empty URL path segment.`;
    throw new ConnectorError({
      message,
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: message,
    });
  }
  return encodeURIComponent(segment).replace(/%3A/gi, ':').replace(/%40/g, '@');
}
