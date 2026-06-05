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
    headers: { ...connectorHeaders, ...(passthrough?.headers ?? {}) },
    query: { ...connectorQuery, ...(passthrough?.query ?? {}) },
  };
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
