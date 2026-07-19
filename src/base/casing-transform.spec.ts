import { describe, it, expect, afterEach, vi } from 'vitest';
import { CasingEnum, transformKeys } from './casing-transform';

describe('transformKeys', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recursively transforms nested plain-object keys', () => {
    expect(
      transformKeys({ outerKey: { innerKey: 'v' } }, CasingEnum.SNAKE_CASE),
    ).toEqual({ outer_key: { inner_key: 'v' } });
  });

  it('does not recurse into Buffer values when Buffer is available', () => {
    const buf = Buffer.from('binary-bytes');
    const result = transformKeys(
      { fileData: buf },
      CasingEnum.SNAKE_CASE,
    );
    // The Buffer is passed through untouched (not treated as a plain object).
    expect(result.file_data).toBe(buf);
    expect(Buffer.isBuffer(result.file_data)).toBe(true);
  });

  it('does not throw on an edge runtime where the Buffer global is undefined', () => {
    // Simulate Cloudflare Workers / Vercel Edge: no `Buffer` global. The hot
    // path (nested _passthrough.body) must not blow up on `value instanceof Buffer`.
    vi.stubGlobal('Buffer', undefined);

    expect(() =>
      transformKeys(
        { passthroughBody: { nestedKey: { deepKey: 'x' } } },
        CasingEnum.SNAKE_CASE,
      ),
    ).not.toThrow();

    expect(
      transformKeys(
        { passthroughBody: { nestedKey: 'x' } },
        CasingEnum.SNAKE_CASE,
      ),
    ).toEqual({ passthrough_body: { nested_key: 'x' } });
  });
});
