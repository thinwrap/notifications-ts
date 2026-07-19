/**
 * Portable base64 helpers that work in Node, Bun, Deno, browsers, and edge
 * runtimes (Cloudflare Workers, Vercel Edge). Avoids reliance on Node's
 * `Buffer` global.
 */

export function encodeBase64Ascii(input: string): string {
  if (typeof btoa === 'function') return btoa(input);
  return Buffer.from(input, 'binary').toString('base64');
}

/**
 * Base64-encode a UTF-8 TEXT string. Unlike {@link encodeBase64Ascii} (which
 * treats each code unit as a raw byte and therefore corrupts / throws on
 * non-ASCII), this first serializes to UTF-8 bytes so `café`/emoji survive the
 * round-trip. Use this for any email content/MIME payload; reserve
 * `encodeBase64Ascii` for guaranteed-ASCII credential strings (`user:pass`).
 */
export function encodeBase64Utf8(input: string): string {
  return encodeBase64Bytes(new TextEncoder().encode(input));
}

export function encodeBase64Bytes(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (typeof btoa === 'function') {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}
