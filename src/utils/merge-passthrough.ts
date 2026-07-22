import type { Passthrough } from '../types';

export type MergedPassthrough<TBody = Record<string, unknown>> = {
  body: TBody;
  headers: Record<string, string>;
  query: Record<string, string>;
};

export function mergePassthrough<TBody extends Record<string, unknown>>(
  connectorBody: TBody,
  connectorHeaders: Record<string, string> = {},
  passthrough?: Passthrough,
  connectorQuery: Record<string, string> = {},
): MergedPassthrough<TBody> {
  return {
    body: deepMergeBody(connectorBody, passthrough?.body ?? {}) as TBody,
    headers: mergePassthroughHeaders(connectorHeaders, passthrough?.headers ?? {}),
    query: { ...connectorQuery, ...(passthrough?.query ?? {}) },
  };
}

/**
 * Shallow-merge passthrough headers over connector headers. On an EXACT-case
 * collision the passthrough value wins (the documented BYO escape hatch). On a
 * CASE-VARIANT collision (e.g. a lowercase `authorization` against a
 * connector-set `Authorization`) the CONNECTOR header wins and the passthrough
 * variant is dropped — otherwise the two distinct object keys both survive and
 * `fetch`/undici comma-joins them into a single malformed header value
 * (`"consumer, connector"`), breaking auth. Connector/signed auth headers must
 * win; a case variant can never be used to override or duplicate them.
 */
function mergePassthroughHeaders(
  connectorHeaders: Record<string, string>,
  passthroughHeaders: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...connectorHeaders };
  const connectorKeyByLower = new Map<string, string>();
  for (const key of Object.keys(connectorHeaders)) {
    connectorKeyByLower.set(key.toLowerCase(), key);
  }
  for (const [key, value] of Object.entries(passthroughHeaders)) {
    const existing = connectorKeyByLower.get(key.toLowerCase());
    // Case-variant of a connector header → connector wins; drop the variant.
    if (existing !== undefined && existing !== key) continue;
    // Exact-case match (passthrough overrides) or no collision (added).
    result[key] = value;
  }
  return result;
}

/**
 * Merge `override` headers over `base` headers where `override` ALWAYS wins,
 * case-insensitively — used where connector-signed headers (SES SigV4: Host,
 * X-Amz-Date, X-Amz-Content-Sha256, Authorization, X-Amz-Security-Token) are
 * applied on top of already-merged passthrough headers. A case-variant of a
 * signed header carried in `base` (e.g. a passthrough lowercase `authorization`)
 * is removed so it cannot produce a comma-joined duplicate with the signed
 * `Authorization`. Returns a plain object (not a `Headers` instance) so callers
 * that pass it straight to `fetch` keep their existing wire shape.
 */
export function mergeHeaders(
  base: Record<string, string>,
  override: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...base };
  const keyByLower = new Map<string, string>();
  for (const key of Object.keys(base)) keyByLower.set(key.toLowerCase(), key);
  for (const [key, value] of Object.entries(override)) {
    const lower = key.toLowerCase();
    const existing = keyByLower.get(lower);
    if (existing !== undefined && existing !== key) delete result[existing];
    result[key] = value;
    keyByLower.set(lower, key);
  }
  return result;
}

function deepMergeBody(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const targetValue = result[key];
    if (isPlainObject(value) && isPlainObject(targetValue)) {
      result[key] = deepMergeBody(targetValue, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
