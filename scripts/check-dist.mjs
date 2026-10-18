// Import-smoke the built dual package exactly the way Node consumers load
// it — no bundler in the loop. Bundlers (vitest, the tree-shaking check)
// tolerate extensionless specifiers that Node's ESM loader rejects, so this
// is the only gate that catches a broken dist/esm emit (the v1.0.0 bug).
// Runs offline; requires `npm run build` first.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = process.cwd();

const EXPECT = ['Email', 'Sms', 'Push', 'Chat', 'ConnectorError', 'SendgridEmailConnector', 'FcmPushConnector'];

function assertSurface(mod, label) {
  for (const name of EXPECT) {
    if (typeof mod[name] !== 'function') {
      console.error(`check-dist: ${label} export '${name}' is ${typeof mod[name]}, expected function`);
      process.exit(1);
    }
  }
}

// CJS — full graph loads through Node's require resolution.
assertSurface(require(resolve(root, 'dist/cjs/index.js')), 'cjs');

// ESM — full graph loads through Node's ESM resolution (this is what
// rejects extensionless/directory specifiers).
assertSurface(await import(pathToFileURL(resolve(root, 'dist/esm/index.js'))), 'esm');

// --- Published declarations must not need @types/node ---------------------
//
// The package is typed for any TS consumer; a `.d.ts` that names a Node-only
// global (`Buffer`, `NodeJS.*`, `process`) or imports a `node:` builtin / a
// package that is not a dependency fails to typecheck for a consumer whose
// tsconfig scopes `types` (TS2591 "Cannot find name 'Buffer'"). The JS import
// smoke above cannot see this, so scan the emitted declarations. Block
// comments are stripped first so JSDoc prose cannot trip the scan.
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const allowed = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const packageOf = (spec) =>
    spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(resolve(dir, e.name)) : e.name.endsWith('.d.ts') ? [resolve(dir, e.name)] : [],
    );
  const SPECIFIER_PATTERNS = [
    // `\sfrom` + a newline-free specifier: `Omit<X, 'from'>` must not read as
    // an import clause.
    /^\s*(?:import|export)\b[^;]*?\sfrom\s*['"]([^'"\n]+)['"]/gm,
    /^\s*import\s*['"]([^'"\n]+)['"]/gm,
    /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /^\s*\/\/\/\s*<reference\s+types\s*=\s*['"]([^'"\n]+)['"]/gm,
  ];
  const NODE_GLOBALS = /\b(?:Buffer|NodeJS\.[A-Za-z]+|process)\b/;

  const offending = [];
  for (const file of walk(resolve(root, 'dist'))) {
    const dts = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/(?!\/).*$/gm, '');
    const rel = file.slice(root.length + 1);
    for (const re of SPECIFIER_PATTERNS) {
      for (const [, spec] of dts.matchAll(re)) {
        if (spec.startsWith('./') || spec.startsWith('../')) continue;
        if (allowed.has(packageOf(spec))) continue;
        offending.push(`${rel} → imports '${spec}'`);
      }
    }
    const global = NODE_GLOBALS.exec(dts);
    if (global) offending.push(`${rel} → names Node-only global '${global[0]}'`);
  }
  if (offending.length > 0) {
    console.error(
      'check-dist: published declarations need modules/globals a consumer may not have:\n  ' +
        offending.join('\n  '),
    );
    process.exit(1);
  }
}

console.log('check-dist: cjs + esm entrypoints load clean; declarations need no @types/node');
