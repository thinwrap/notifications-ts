import { describe, it, expect } from 'vitest';
import { createRetryAfterFixture } from './retry-after-fixture';

describe('createRetryAfterFixture (helper)', () => {
  it('builds a 429 response with integer-seconds Retry-After', () => {
    const res = createRetryAfterFixture({ status: 429, retryAfter: '30' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('builds a 503 response with HTTP-date Retry-After', () => {
    const httpDate = 'Wed, 21 Oct 2026 07:28:00 GMT';
    const res = createRetryAfterFixture({ status: 503, retryAfter: httpDate });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe(httpDate);
  });

  it('omits the Retry-After header when retryAfter is null', () => {
    const res = createRetryAfterFixture({ status: 429, retryAfter: null });
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('omits the Retry-After header when retryAfter is undefined', () => {
    const res = createRetryAfterFixture({ status: 503 });
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('encodes errorBody as JSON by default', async () => {
    const res = createRetryAfterFixture({
      status: 429,
      retryAfter: '30',
      errorBody: { errors: [{ message: 'throttled' }] },
    });
    const json = (await res.json()) as { errors: { message: string }[] };
    expect(json.errors[0]?.message).toBe('throttled');
  });

  it('passes through string errorBody for non-JSON vendors', async () => {
    const res = createRetryAfterFixture({
      status: 503,
      retryAfter: '60',
      errorBody: 'Service Unavailable',
      contentType: 'text/plain',
    });
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(await res.text()).toBe('Service Unavailable');
  });

  it('defaults to an empty JSON object body when errorBody is omitted', async () => {
    const res = createRetryAfterFixture({ status: 429, retryAfter: '30' });
    expect(await res.json()).toEqual({});
  });
});
