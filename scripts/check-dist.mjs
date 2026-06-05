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

console.log('check-dist: cjs + esm entrypoints load clean');
