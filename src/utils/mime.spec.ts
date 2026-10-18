import { describe, it, expect } from 'vitest';
import { encodeWords, formatMailbox } from './mime';

function decodeWords(s: string): string {
  return s
    .split(' ')
    .map((w) => {
      const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w);
      if (!m) throw new Error(`not an encoded-word: ${w}`);
      return Buffer.from(m[1]!, 'base64');
    })
    .reduce((acc, b) => Buffer.concat([acc, b]), Buffer.alloc(0))
    .toString('utf8');
}

describe('formatMailbox (RFC 5322 §3.4 mailbox, RFC 2047 §5)', () => {
  it('bare address when there is no display name', () => {
    expect(formatMailbox(undefined, 'a@b.c')).toBe('a@b.c');
    expect(formatMailbox('', 'a@b.c')).toBe('a@b.c');
  });

  it('atext-only name is an unquoted phrase', () => {
    expect(formatMailbox('Acme Mail', 'a@b.c')).toBe('Acme Mail <a@b.c>');
  });

  // Postmark send guide: "\"Joe Receiver, Jr.\" <receiver@example.com>"
  it('a name with specials is a quoted-string, with " and \\ escaped', () => {
    expect(formatMailbox('Joe Receiver, Jr.', 'r@example.com')).toBe('"Joe Receiver, Jr." <r@example.com>');
    expect(formatMailbox('Say "hi" \\ o/', 'a@b.c')).toBe('"Say \\"hi\\" \\\\ o/" <a@b.c>');
  });

  it('a non-ASCII name is encoded-words, never inside quotes', () => {
    const out = formatMailbox('Zoë, Ltd.', 'z@b.c');
    expect(out).toMatch(/^=\?UTF-8\?B\?[^"]+\?= <z@b\.c>$/);
    expect(decodeWords(out.slice(0, out.indexOf(' <')))).toBe('Zoë, Ltd.');
  });

  it('a pre-formatted "Name <addr>" is parsed: its name wins, is re-encoded, and brackets never nest', () => {
    expect(formatMailbox(undefined, 'Acme Mail <a@b.c>')).toBe('Acme Mail <a@b.c>');
    expect(formatMailbox('Bob', 'Zoë <z@x.com>')).toBe('=?UTF-8?B?Wm/Dqw==?= <z@x.com>');
    expect(formatMailbox('Bob', '"Doe, Jane" <j@x.com>')).toBe('"Doe, Jane" <j@x.com>');
    expect(formatMailbox('Bob', '<only@x.com>')).toBe('Bob <only@x.com>');
    expect(formatMailbox('Bob', 'Zoë <z@x.com>')).not.toMatch(/<[^>]*</);
  });

  it('CR/LF in name or address cannot inject a header', () => {
    expect(formatMailbox('A\r\nBcc: x@y.z', 'a@b.c\r\n')).not.toMatch(/[\r\n]/);
  });
});

describe('encodeWords (RFC 2047 §2: "may not be more than 75 characters long")', () => {
  it('leaves ASCII untouched', () => {
    expect(encodeWords('plain value')).toBe('plain value');
  });

  it('splits long input into ≤75-char words on UTF-8 character boundaries', () => {
    const value = 'Grüße aus Köln — 日本語のテキスト 🎉'.repeat(6);
    const out = encodeWords(value);
    const words = out.split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    // each word decodes on its own (no split multi-byte sequence)
    for (const w of words) expect(decodeWords(w)).not.toContain('�');
    expect(decodeWords(out)).toBe(value);
  });
});
