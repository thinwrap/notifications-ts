#!/usr/bin/env node
/**
 * Per-connector README frontmatter validator.
 *
 * Reads every `src/providers/<id>/README.md`, parses the leading YAML
 * frontmatter (between `---` delimiters), and validates required keys and
 * value shapes against the schema documented in
 * `schemas/connector-readme-schema.yaml`. Exits 0 on success, 1 with
 * line-prefixed errors on any failure.
 *
 * — designed to be wired into a CI lint-gates job
 * in. Standalone (no runtime deps) so it can run pre-commit too.
 *
 * Usage:
 *   node scripts/validate-frontmatter.mjs
 *   node scripts/validate-frontmatter.mjs --expected-count 34
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROVIDERS_DIR = join(REPO_ROOT, 'src', 'providers');

const args = process.argv.slice(2);
const expectedCountIdx = args.indexOf('--expected-count');
const EXPECTED_COUNT =
  expectedCountIdx >= 0 ? Number(args[expectedCountIdx + 1]) : 35;

// --- minimal YAML parser scoped to the frontmatter shape we accept ---
// Supports: scalar keys, nested objects (2-space indent), arrays of scalars,
// quoted and unquoted strings, booleans, integers, and the YAML literal
// block scalar (`|`) used by `notes_passthrough`.
function parseFrontmatter(text) {
  const lines = text.split('\n');
  const root = {};
  let i = 0;

  function parseBlock(indent) {
    const obj = {};
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '' || raw.trim().startsWith('#')) {
        i += 1;
        continue;
      }
      const currentIndent = raw.match(/^ */)[0].length;
      if (currentIndent < indent) return obj;
      if (currentIndent > indent) {
        throw new Error(`Unexpected indent at line ${i + 1}: "${raw}"`);
      }
      const line = raw.slice(indent);
      // Array item at this level — handled by parseArray; caller catches.
      if (line.startsWith('- ')) return obj;

      const colon = line.indexOf(':');
      if (colon === -1) {
        throw new Error(`Expected key:value at line ${i + 1}: "${raw}"`);
      }
      const key = line.slice(0, colon).trim();
      const rest = line.slice(colon + 1).trim();
      i += 1;

      if (rest === '') {
        // Nested mapping or array.
        // Peek next non-empty line to decide.
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j += 1;
        if (j >= lines.length) {
          obj[key] = null;
          continue;
        }
        const peek = lines[j];
        const peekIndent = peek.match(/^ */)[0].length;
        if (peekIndent <= indent) {
          obj[key] = null;
          continue;
        }
        const peekLine = peek.slice(peekIndent);
        if (peekLine.startsWith('- ')) {
          obj[key] = parseArray(peekIndent);
        } else {
          obj[key] = parseBlock(peekIndent);
        }
      } else if (rest === '|') {
        // Literal block scalar — collect indented lines.
        const blockIndent = indent + 2;
        const collected = [];
        while (i < lines.length) {
          const bl = lines[i];
          if (bl.trim() === '') {
            collected.push('');
            i += 1;
            continue;
          }
          const blIndent = bl.match(/^ */)[0].length;
          if (blIndent < blockIndent) break;
          collected.push(bl.slice(blockIndent));
          i += 1;
        }
        obj[key] = collected.join('\n').replace(/\n+$/, '');
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        // Inline flow-array (used rarely; we accept simple comma-separated).
        const inner = rest.slice(1, -1).trim();
        obj[key] = inner === '' ? [] : inner.split(',').map((s) => coerceScalar(s.trim()));
      } else {
        obj[key] = coerceScalar(rest);
      }
    }
    return obj;
  }

  function parseArray(indent) {
    const arr = [];
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '' || raw.trim().startsWith('#')) {
        i += 1;
        continue;
      }
      const currentIndent = raw.match(/^ */)[0].length;
      if (currentIndent < indent) return arr;
      const line = raw.slice(indent);
      if (!line.startsWith('- ')) return arr;
      const item = line.slice(2).trim();
      arr.push(coerceScalar(item));
      i += 1;
    }
    return arr;
  }

  function coerceScalar(s) {
    if (s === '' || s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const indent = raw.match(/^ */)[0].length;
    Object.assign(root, parseBlock(indent));
    break;
  }
  // Continue parsing top-level keys after nested blocks.
  while (i < lines.length) {
    Object.assign(root, parseBlock(0));
    // Avoid infinite loop on stale state.
    const before = i;
    if (i === before) i += 1;
  }
  return root;
}

function extractFrontmatter(content, file) {
  if (!content.startsWith('---')) {
    throw new Error(
      `${file}: missing frontmatter — file must start with '---' delimiter on line 1`,
    );
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    throw new Error(`${file}: missing closing '---' delimiter for frontmatter`);
  }
  const yamlText = content.slice(3, end).replace(/^\n/, '');
  return parseFrontmatter(yamlText);
}

// --- schema validation ---
const AUTH_METHODS = new Set([
  'api-key-header',
  'api-key-query',
  'basic-auth',
  'bearer',
  'oauth2-client-credentials',
  'jwt-rs256',
  'jwt-es256',
  'aws-sigv4',
  'hmac',
  'webhook-url-secret',
  'bot-token-url',
  'dual-header',
  'none',
]);
const TOKEN_LIFECYCLES = new Set([
  'static',
  'rotating',
  'short-lived-signed',
  'vendor-managed',
]);
const CHANNELS = new Set(['email', 'sms', 'push', 'chat']);
const REQUIRED_TOP = [
  'providerId',
  'channel',
  'auth',
  'endpoint',
  'versioning',
  'notes_passthrough',
];

function validate(meta, file) {
  const errors = [];
  for (const key of REQUIRED_TOP) {
    if (!(key in meta) || meta[key] === null || meta[key] === undefined) {
      errors.push(`${file}: missing required key '${key}'`);
    }
  }
  if (meta.providerId && !/^[a-z][a-z0-9-]*$/.test(meta.providerId)) {
    errors.push(
      `${file}: providerId '${meta.providerId}' must match /^[a-z][a-z0-9-]*$/`,
    );
  }
  if (meta.channel && !CHANNELS.has(meta.channel)) {
    errors.push(
      `${file}: channel '${meta.channel}' must be one of ${[...CHANNELS].join(', ')}`,
    );
  }
  if (meta.auth && typeof meta.auth === 'object') {
    for (const k of ['method', 'tokenLifecycle', 'tokenCacheHookSupported']) {
      if (!(k in meta.auth)) {
        errors.push(`${file}: auth.${k} is required`);
      }
    }
    if (meta.auth.method && !AUTH_METHODS.has(meta.auth.method)) {
      errors.push(
        `${file}: auth.method '${meta.auth.method}' must be one of ${[...AUTH_METHODS].join(', ')}`,
      );
    }
    if (
      meta.auth.tokenLifecycle &&
      !TOKEN_LIFECYCLES.has(meta.auth.tokenLifecycle)
    ) {
      errors.push(
        `${file}: auth.tokenLifecycle '${meta.auth.tokenLifecycle}' must be one of ${[...TOKEN_LIFECYCLES].join(', ')}`,
      );
    }
    if (
      'tokenCacheHookSupported' in meta.auth &&
      typeof meta.auth.tokenCacheHookSupported !== 'boolean'
    ) {
      errors.push(`${file}: auth.tokenCacheHookSupported must be a boolean`);
    }
  }
  if (meta.endpoint && typeof meta.endpoint === 'object') {
    if (!meta.endpoint.default) {
      errors.push(`${file}: endpoint.default is required`);
    } else if (
      typeof meta.endpoint.default !== 'string' ||
      !/^https?:\/\//.test(meta.endpoint.default)
    ) {
      errors.push(
        `${file}: endpoint.default must be an http(s) URL (got '${meta.endpoint.default}')`,
      );
    }
  }
  if (meta.versioning && typeof meta.versioning === 'object') {
    if (!meta.versioning.vendorApiVersion) {
      errors.push(`${file}: versioning.vendorApiVersion is required`);
    }
    if (!meta.versioning.lastVerified) {
      errors.push(`${file}: versioning.lastVerified is required`);
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.versioning.lastVerified))) {
      errors.push(
        `${file}: versioning.lastVerified '${meta.versioning.lastVerified}' must be ISO date YYYY-MM-DD`,
      );
    }
  }
  if (
    'notes_passthrough' in meta &&
    typeof meta.notes_passthrough !== 'string'
  ) {
    errors.push(`${file}: notes_passthrough must be a string`);
  }
  return errors;
}

function listProviderReadmes() {
  const entries = readdirSync(PROVIDERS_DIR, { withFileTypes: true });
  const readmes = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const readme = join(PROVIDERS_DIR, e.name, 'README.md');
    try {
      const s = statSync(readme);
      if (s.isFile()) readmes.push({ id: e.name, path: readme });
    } catch {
      readmes.push({ id: e.name, path: readme, missing: true });
    }
  }
  return readmes;
}

function main() {
  const readmes = listProviderReadmes();
  const errors = [];

  const present = readmes.filter((r) => !r.missing);
  const missing = readmes.filter((r) => r.missing);
  for (const m of missing) {
    errors.push(`${m.path}: missing per-connector README`);
  }

  for (const r of present) {
    const content = readFileSync(r.path, 'utf8');
    try {
      const meta = extractFrontmatter(content, r.path);
      const errs = validate(meta, r.path);
      errors.push(...errs);
      if (meta.providerId && meta.providerId !== r.id) {
        errors.push(
          `${r.path}: providerId '${meta.providerId}' does not match directory name '${r.id}'`,
        );
      }
    } catch (e) {
      errors.push(`${r.path}: ${e.message}`);
    }
  }

  const total = present.length;
  if (Number.isFinite(EXPECTED_COUNT) && total !== EXPECTED_COUNT) {
    errors.push(
      `coverage: found ${total} per-connector README(s); expected ${EXPECTED_COUNT}`,
    );
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(`\n${errors.length} error(s) — frontmatter validation failed.`);
    process.exit(1);
  }
  console.log(
    `OK — ${total} per-connector README(s) validated against schemas/connector-readme-schema.yaml`,
  );
}

main();
