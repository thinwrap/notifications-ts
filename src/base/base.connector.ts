import { ConnectorError } from '../types';

export abstract class BaseConnector {
  protected readonly fetchImpl: typeof fetch;

  protected constructor(fetchImpl?: typeof fetch) {
    const baseFetch = fetchImpl ?? globalThis.fetch;
    // Force `redirect: 'error'` on every request at the transport seam so a 3xx
    // can never silently re-send credentials to the redirect target. `fetch`
    // strips only `Authorization`/`Cookie` cross-origin, so custom credential
    // headers (X-Postmark-Server-Token, api-key, X-Auth-Token, X-TM-*, …) would
    // otherwise leak. No notification endpoint legitimately redirects a POST.
    //
    // This wrapper — not `invokeFetch` — is where transport normalization has to
    // live: nearly every connector calls `this.fetchImpl` directly with its own
    // catch block, so it is the single seam all of them share. Two guarantees
    // are established here, once, for every connector:
    //
    //   1. A non-2xx always arrives as a `Response`, even when the host's global
    //      undici dispatcher rejects instead of resolving it, so each
    //      connector's `if (!response.ok) throw this.mapVendorError(...)` runs.
    //   2. Anything that does reject carries no credential, so the connectors'
    //      `(error as Error).message` cannot log one.
    this.fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assertSafeHeaders(init?.headers);
      try {
        return await baseFetch(input, { ...init, redirect: 'error' });
      } catch (err) {
        const rebuilt = responseFromThrownHttpError(err);
        if (rebuilt !== null) return rebuilt;
        throw sanitizeTransportError(err);
      }
    }) as typeof fetch;
  }

  protected async sendPostJson(
    url: string,
    body: unknown,
    options?: { headers?: Record<string, string>; query?: Record<string, string> },
  ): Promise<Response> {
    return this.invokeFetch(appendQuery(url, options?.query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(body),
    });
  }

  /**
   * Form-encoded POST with multi-value entry support — array values produce
   * repeated `key=` fields (e.g. Twilio expects multiple `MediaUrl=` fields
   * for MMS, not a comma-joined value). `null`/`undefined` entries are
   * skipped; everything else is `String()`-coerced.
   */
  protected async sendPostForm(
    url: string,
    form: Record<string, unknown>,
    options?: { headers?: Record<string, string>; query?: Record<string, string> },
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, String(v));
      } else {
        params.append(key, String(value));
      }
    }
    return this.invokeFetch(appendQuery(url, options?.query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...options?.headers },
      body: params.toString(),
    });
  }

  private async invokeFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      if ((err as Error)?.name === 'AbortError') {
        throw new ConnectorError({
          message: (err as Error).message ?? 'Request cancelled',
          statusCode: null,
          providerCode: 'invalid_request',
          cause: err,
        });
      }
      throw new ConnectorError({
        message: (err as Error).message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: err },
      });
    }
  }
}

/**
 * Refuse a header whose name or value carries CR, LF or NUL before the request
 * is built. undici would reject it with a TypeError that the transport seam
 * turns into an opaque `provider_unavailable`, and a lenient custom `fetch`
 * could put it on the wire (header injection). The message names the header,
 * never its value — header values are where credentials live.
 */
function assertSafeHeaders(headers: RequestInit['headers'] | undefined): void {
  if (headers === undefined || headers === null) return;
  const entries: Array<[string, unknown]> =
    typeof Headers === 'function' && headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? (headers as Array<[string, unknown]>)
        : Object.entries(headers as Record<string, unknown>);
  for (const [name, value] of entries) {
    const unsafe = /[\r\n\0]/;
    const badValue =
      value !== null && typeof value === 'object'
        ? true
        : value !== undefined && unsafe.test(String(value));
    if (unsafe.test(String(name)) || badValue) {
      const shownName = unsafe.test(String(name)) ? '(invalid name)' : String(name);
      const message = `Header ${shownName} must be a single-line string (no CR, LF or NUL).`;
      throw new ConnectorError({
        message,
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: message,
      });
    }
  }
}

function appendQuery(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${new URLSearchParams(query).toString()}`;
}

// ---------------------------------------------------------------------------
// Transport-rejection normalization (duck-typed; never an `undici` import)
// ---------------------------------------------------------------------------

/** Walk `err`, `err.cause`, `err.cause.cause` — deep enough for a wrapped rejection. */
function* errorChain(err: unknown, depth = 3): Generator<Record<string, unknown>> {
  let current = err;
  for (let i = 0; i < depth; i++) {
    if (current === null || typeof current !== 'object') return;
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * Rebuild a `Response` from a rejection carrying an HTTP status, or `null` when
 * the rejection is a genuine transport failure.
 *
 * Fetch resolves a non-2xx; a dispatcher may reject instead. On Node,
 * `globalThis.fetch` runs through undici's **process-global** dispatcher, which
 * the host application can replace at any time — `setGlobalDispatcher(new
 * Agent().compose(retry(), interceptors.responseError()))` is ordinary app code
 * — with no signal reaching this library. Under it, `fetch` rejects with
 * `TypeError: fetch failed` whose `.cause` carries `statusCode`/`headers`/`body`,
 * and every connector's status mapping (429 → `rate_limited`, 401 →
 * `auth_failed`, …) silently stops running.
 *
 * Only `body` is read as a body. undici's retry-exhaustion error carries a
 * `data` field holding `{ count }` retry metadata, NOT the response payload;
 * treating it as one would fabricate a body the provider never sent.
 */
function responseFromThrownHttpError(err: unknown): Response | null {
  if (typeof Response !== 'function') return null;

  for (const link of errorChain(err)) {
    const status = link.statusCode ?? link.status;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
      continue;
    }
    // 204/205/304 are null-body statuses; `new Response(body, …)` throws for them.
    const body =
      status === 204 || status === 205 || status === 304 ? null : readErrorBody(link.body, link.headers);
    try {
      return new Response(body, { status, headers: readErrorHeaders(link.headers) });
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Normalize a buffered error body to something the `Response` constructor accepts.
 *
 * A `content-encoding` on the error means the body was buffered **still
 * compressed** and is unrecoverable — drop it rather than hand a connector
 * mojibake. A dispatcher-level interceptor sits *below* fetch's content-decoding,
 * so it buffers raw wire bytes and text-decodes them; gzip is not valid UTF-8, so
 * every invalid byte becomes U+FFFD before we ever see the value. Measured on a
 * real gzipped 400: 16 of 66 bytes replaced, the `1f 8b` magic destroyed, and
 * re-encoding as latin1/binary/utf8 all fail to inflate (`Z_DATA_ERROR`). There
 * is nothing here to salvage — not with `zlib`, not with anything.
 *
 * (Verified against undici 8.9: this is driven by `content-encoding`, not by the
 * `;charset=` suffix — its content-type check is a prefix match. Its own
 * `decompress()` interceptor does not help in any composition order.)
 */
function readErrorBody(body: unknown, headers: unknown): string | Uint8Array | ArrayBuffer | null {
  if (typeof body === 'string') return isContentEncoded(headers) ? null : body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return body;
  if (body === null || body === undefined) return null;
  if (typeof body === 'object') {
    // Already-decoded JSON (undici parses `application/json` before throwing).
    try {
      return JSON.stringify(body);
    } catch {
      return null;
    }
  }
  return null;
}

/** Whether the error's headers declare a body encoding other than `identity`. */
function isContentEncoded(headers: unknown): boolean {
  if (headers === null || typeof headers !== 'object') return false;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== 'content-encoding') continue;
    const encoding = (Array.isArray(value) ? value.join(',') : String(value)).trim().toLowerCase();
    return encoding !== '' && encoding !== 'identity';
  }
  return false;
}

/**
 * Copy the string-valued headers off a thrown error. `content-length` and
 * `content-encoding` are dropped: they describe a wire encoding that no longer
 * applies once the body has been decoded and re-serialized.
 */
function readErrorHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const name = key.toLowerCase();
    if (name === 'content-length' || name === 'content-encoding') continue;
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[name] = value.join(', ');
    }
  }
  return out;
}

/**
 * Replace a transport rejection with one carrying no credential.
 *
 * This channel is the worst place in the library for a raw error to escape: the
 * credential is in the **URL path** for Telegram (`/bot<token>/…`) and in the
 * whole URL for every webhook provider (Slack, Discord, Mattermost, MS Teams,
 * Google Chat, Rocket.Chat). undici embeds the request URL in its message, and
 * connectors surface `(error as Error).message` as `ConnectorError.message` —
 * so the secret would land in any log that records the error (CWE-532). The PHP
 * sibling has always used a fixed message here; this brings TypeScript in line.
 *
 * `name` is preserved because connectors branch on `err.name === 'AbortError'`
 * to classify a cancellation; `code` is preserved when it is identifier-shaped,
 * since that is the field that actually names the failure.
 */
function sanitizeTransportError(err: unknown): Error {
  const original = err as Error | undefined;
  const safe = new Error(original?.name === 'AbortError' ? 'Request cancelled' : 'Network error');
  safe.name = typeof original?.name === 'string' ? original.name : 'Error';

  const [self, cause] = [...errorChain(err, 2)];
  const code = readDiagnosticCode(self?.code) ?? readDiagnosticCode(cause?.code);
  if (code !== undefined) (safe as Error & { code?: string }).code = code;

  return safe;
}

/**
 * A diagnostic-code shape: identifier characters only. A credential would reach
 * here inside a URL, which cannot match this pattern (no `/`, `:`, `?`, `=` or
 * whitespace). Length-capped so an opaque token cannot masquerade as one.
 */
const DIAGNOSTIC_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function readDiagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && DIAGNOSTIC_CODE.test(value) ? value : undefined;
}
