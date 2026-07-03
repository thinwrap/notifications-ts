/**
 * MIME/multipart header sanitization helpers shared across email connectors
 * (SES, Mailgun). Attacker-influenced attachment `contentType`/`filename`
 * values must never be able to inject or override MIME/multipart part headers
 * via embedded CR/LF.
 */

/**
 * Strip CR/LF characters from a header value to prevent header injection.
 * MIME header field bodies cannot contain bare CR/LF; any caller-supplied
 * value that does is sanitised to spaces.
 */
export function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Sanitize a MIME/multipart filename WITHOUT adding surrounding quotes: strips
 * CR/LF then backslash-escapes embedded `"`/`\`. For templates that already
 * supply the surrounding `"..."` (e.g. Mailgun `filename="${...}"`). Use
 * `quoteMimeFilename` when the surrounding quotes are not already present.
 */
export function escapeMimeFilename(name: string): string {
  return stripCrlf(name).replace(/(["\\])/g, '\\$1');
}

/**
 * Quote a MIME filename that may contain `"` or other special characters per
 * RFC 2183. Bare filenames are quoted; embedded `"` is backslash-escaped.
 */
export function quoteMimeFilename(name: string): string {
  return `"${escapeMimeFilename(name)}"`;
}
