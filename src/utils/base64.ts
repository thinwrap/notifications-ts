/**
 * Portable base64 helpers that work in Node, Bun, Deno, browsers, and edge
 * runtimes (Cloudflare Workers, Vercel Edge). Avoids reliance on Node's
 * `Buffer` global.
 */

export function encodeBase64Ascii(input: string): string {
  if (typeof btoa === 'function') return btoa(input);
  return Buffer.from(input, 'binary').toString('base64');
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
