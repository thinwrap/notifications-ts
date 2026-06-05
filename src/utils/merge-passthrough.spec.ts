import { describe, it, expect } from 'vitest';
import { mergePassthrough } from './merge-passthrough';

describe('mergePassthrough', () => {
  it('returns the connector body unchanged when passthrough is undefined', () => {
    const result = mergePassthrough({ foo: 'bar', n: 1 });
    expect(result.body).toEqual({ foo: 'bar', n: 1 });
    expect(result.headers).toEqual({});
    expect(result.query).toEqual({});
  });

  it('deep-merges nested plain objects', () => {
    const result = mergePassthrough(
      { settings: { tracking: { clicks: true }, name: 'a' } },
      {},
      { body: { settings: { tracking: { opens: true } } } }
    );
    expect(result.body).toEqual({
      settings: { tracking: { clicks: true, opens: true }, name: 'a' },
    });
  });

  it('last-write-wins on arrays (passthrough array replaces connector array)', () => {
    const result = mergePassthrough(
      { tags: ['a', 'b'] },
      {},
      { body: { tags: ['c'] } }
    );
    expect(result.body).toEqual({ tags: ['c'] });
  });

  it('last-write-wins on primitives', () => {
    const result = mergePassthrough(
      { name: 'original', age: 1 },
      {},
      { body: { name: 'override' } }
    );
    expect(result.body).toEqual({ name: 'override', age: 1 });
  });

  it('does NOT overwrite target keys when source value is undefined', () => {
    const result = mergePassthrough(
      { name: 'keep' },
      {},
      { body: { name: undefined as unknown as string } }
    );
    expect(result.body).toEqual({ name: 'keep' });
  });

  it('preserves Buffer attachments (does not deep-merge into them)', () => {
    const buf = Buffer.from('attachment-bytes');
    const result = mergePassthrough(
      { content: buf, name: 'file' },
      {},
      { body: { name: 'override' } }
    );
    expect(result.body.content).toBe(buf);
    expect(result.body.name).toBe('override');
  });

  it('shallow-merges headers with last-write-wins', () => {
    const result = mergePassthrough(
      { foo: 'bar' },
      { 'X-Connector': 'a', 'X-Shared': 'connector' },
      { headers: { 'X-Passthrough': 'p', 'X-Shared': 'passthrough' } }
    );
    expect(result.headers).toEqual({
      'X-Connector': 'a',
      'X-Shared': 'passthrough',
      'X-Passthrough': 'p',
    });
  });

  it('shallow-merges query with last-write-wins', () => {
    const result = mergePassthrough(
      { foo: 'bar' },
      {},
      { query: { region: 'eu' } },
      { region: 'us', limit: '10' }
    );
    expect(result.query).toEqual({ region: 'eu', limit: '10' });
  });
});
