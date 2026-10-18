import { encodeBase64Bytes } from './base64';

/**
 * MIME/multipart header helpers shared across email connectors (Mailgun's
 * multipart body, mailbox/encoded-word formatting for SES, Resend, Postmark
 * and Mailgun). Attacker-influenced attachment `contentType`/`filename`
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

// RFC 5322 §3.2.3 `atext` plus SP: a display name made only of these is a
// valid `phrase` of atoms and needs no quoting.
const ATEXT_PHRASE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * Format an RFC 5322 mailbox (`display-name <addr-spec>`) for vendors that
 * take `From` as one string (SES `FromEmailAddress`, Resend, Postmark,
 * Mailgun).
 *
 * - An atext-only name is sent as-is (`Acme Mail <a@b.c>`).
 * - An ASCII name containing specials (`, . " ( ) < > @ : ; [ ] \`) must be a
 *   quoted-string, or `Doe, Jane` would parse as two mailboxes.
 * - A non-ASCII name becomes RFC 2047 encoded-words and is NOT quoted: RFC
 *   2047 §5 says "An 'encoded-word' MUST NOT appear within a
 *   'quoted-string'". SES's developer guide requires this form for a Unicode
 *   "friendly from" name.
 */
export function formatMailbox(name: string | undefined, addr: string): string {
  let address = stripCrlf(addr);
  let rawName = name;
  // `addr` may already be `Name <addr>`. Its own display name wins over
  // `name`: it is the per-message value, and wrapping it again would nest
  // angle brackets (`Bob <Zoë <z@x.com>>`). The embedded name is re-encoded
  // like any other, since SES needs encoded-words for a Unicode name.
  const preformatted = /^(.*)<([^<>]*)>$/s.exec(address);
  if (preformatted) {
    const embedded = preformatted[1]!.trim();
    address = preformatted[2]!.trim();
    if (embedded !== '') rawName = unquotePhrase(embedded);
  }
  const display = rawName === undefined ? '' : stripCrlf(rawName);
  if (display === '') return address;
  let phrase: string;
  if (NON_ASCII.test(display)) phrase = encodeWords(display);
  else if (ATEXT_PHRASE.test(display)) phrase = display;
  else phrase = `"${display.replace(/(["\\])/g, '\\$1')}"`;
  return `${phrase} <${address}>`;
}

/** Undo RFC 5322 quoted-string quoting (`"Doe, Jane"` → `Doe, Jane`). */
function unquotePhrase(phrase: string): string {
  if (phrase.length >= 2 && phrase.startsWith('"') && phrase.endsWith('"')) {
    return phrase.slice(1, -1).replace(/\\(.)/gs, '$1');
  }
  return phrase;
}

/**
 * RFC 2047 base64 encoded-words for a header value. ASCII input is returned
 * unchanged. RFC 2047 §2: "An 'encoded-word' may not be more than 75
 * characters long", so the UTF-8 bytes are split — only on character
 * boundaries — into 45-byte runs (60 base64 chars + 12 for `=?UTF-8?B?…?=`)
 * and the words are joined with a space, which decoders drop between
 * adjacent encoded-words.
 */
export function encodeWords(value: string): string {
  if (!NON_ASCII.test(value)) return value;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let run: number[] = [];
  for (const ch of value) {
    const bytes = encoder.encode(ch);
    if (run.length + bytes.length > 45) {
      words.push(`=?UTF-8?B?${encodeBase64Bytes(Uint8Array.from(run))}?=`);
      run = [];
    }
    run.push(...bytes);
  }
  if (run.length > 0) words.push(`=?UTF-8?B?${encodeBase64Bytes(Uint8Array.from(run))}?=`);
  return words.join(' ');
}
