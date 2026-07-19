import { describe, it, expect } from 'vitest';
import { encodeBase64Ascii, encodeBase64Bytes, encodeBase64Utf8 } from './base64';

describe('encodeBase64Utf8', () => {
  it('round-trips non-ASCII text through correct UTF-8 bytes', () => {
    const input = 'café ☕';
    const encoded = encodeBase64Utf8(input);

    // Matches a UTF-8-aware base64 (not latin1/code-unit).
    expect(encoded).toBe(Buffer.from(input, 'utf-8').toString('base64'));
    // And decodes back to the original string.
    expect(Buffer.from(encoded, 'base64').toString('utf-8')).toBe(input);
  });

  it('produces the same bytes as encoding the UTF-8 byte array directly', () => {
    const input = 'Grüße 🎉 — こんにちは';
    expect(encodeBase64Utf8(input)).toBe(
      encodeBase64Bytes(new TextEncoder().encode(input)),
    );
  });

  it('agrees with encodeBase64Ascii for pure-ASCII input', () => {
    const ascii = 'hello world:123';
    expect(encodeBase64Utf8(ascii)).toBe(encodeBase64Ascii(ascii));
    expect(encodeBase64Utf8(ascii)).toBe(
      Buffer.from(ascii, 'utf-8').toString('base64'),
    );
  });

  it('differs from encodeBase64Ascii for non-ASCII input (the corruption it fixes)', () => {
    // encodeBase64Ascii treats each code unit as a raw byte (latin1), so `é`
    // (U+00E9) becomes one byte 0xE9 instead of the UTF-8 pair 0xC3 0xA9.
    const input = 'café';
    expect(encodeBase64Utf8(input)).not.toBe(encodeBase64Ascii(input));
    expect(Buffer.from(encodeBase64Utf8(input), 'base64').toString('utf-8')).toBe(
      input,
    );
  });
});

describe('encodeBase64Ascii', () => {
  it('encodes guaranteed-ASCII credential strings (user:pass)', () => {
    const cred = 'api:key-abc123';
    expect(encodeBase64Ascii(cred)).toBe(
      Buffer.from(cred, 'utf-8').toString('base64'),
    );
  });
});
