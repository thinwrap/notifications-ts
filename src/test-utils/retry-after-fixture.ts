/**
 * Retry-After fixture helper for vitest specs.
 *
 * Produces a mock `Response` suitable for:
 *   vi.mocked(globalThis.fetch).mockResolvedValueOnce(createRetryAfterFixture({ ... }))
 *
 * Used by every connector spec asserting Retry-After surfacing
 * through ConnectorError.providerMessage + cause.retryAfter.
 *
 * Retry is consumer policy: the wrapper does NOT add a
 * structured `retryAfterSeconds` field to ConnectorError. The raw header
 * value is preserved in `cause.retryAfter` (the parsed string), and the
 * parsed seconds value is included in `providerMessage` text. The wrapper
 * itself does no retry — retry is consumer policy.
 *
 * See `.ai/TEST-FIXTURES.md` for the canonical per-connector assertion
 * pattern.
 */

export interface RetryAfterFixtureOptions {
  /** HTTP status the fixture should reply with. 429 or 503 are the canonical cases. */
  status: 429 | 503;
  /**
   * Retry-After header value:
   *  - integer-string seconds (e.g. `'30'`) — the most common form
   *  - HTTP-date string (e.g. `'Wed, 21 Oct 2026 07:28:00 GMT'`)
   *  - `null` or omitted — the header is absent (vendor returned 429/503 with no Retry-After)
   */
  retryAfter?: string | null;
  /**
   * Optional JSON body returned alongside the error. Default: `{}`.
   * Some vendors return a structured error envelope (e.g. SendGrid's
   * `{ errors: [{ message: 'throttled' }] }`); pass it here to exercise
   * the connector's error-translation path.
   */
  errorBody?: unknown;
  /**
   * Optional override of the Content-Type header. Default: `application/json`.
   * Set to `'text/plain'` for vendors that return non-JSON error bodies.
   */
  contentType?: string;
}

/**
 * Builds a mock `Response` for use with `vi.mocked(globalThis.fetch).mockResolvedValueOnce(...)`.
 *
 * @example
 *   const fixture = createRetryAfterFixture({ status: 429, retryAfter: '30' });
 *   vi.mocked(globalThis.fetch).mockResolvedValueOnce(fixture);
 *   await expect(connector.send(input)).rejects.toMatchObject({
 *     providerCode: 'rate_limited',
 *     providerMessage: expect.stringContaining('30'),
 *     cause: expect.objectContaining({ retryAfter: '30' }),
 *   });
 */
export function createRetryAfterFixture(opts: RetryAfterFixtureOptions): Response {
  const headers = new Headers({ 'Content-Type': opts.contentType ?? 'application/json' });
  if (opts.retryAfter != null) {
    headers.set('Retry-After', opts.retryAfter);
  }
  const body = opts.errorBody === undefined ? {} : opts.errorBody;
  const bodyText =
    typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(bodyText, {
    status: opts.status,
    headers,
  });
}
