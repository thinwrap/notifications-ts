// Post-build fixup for the ESM emit. tsc copies the extensionless relative
// specifiers written in source ('./types', './base/base.connector') straight
// into dist/esm, but Node's ESM loader requires fully-resolved file paths.
// Rewrite every relative import/export specifier in dist/esm/**/*.{js,d.ts}
// to its resolvable form ('./x' -> './x.js' or './x/index.js') and stamp
// dist/esm + dist/cjs with package.json type markers so the dual build is
// unambiguous on every Node version.
//
// Runs as the final step of `npm run build`. `npm run check:dist` then
// import-smokes both builds the way real Node consumers load them.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ESM = resolve(process.cwd(), 'dist/esm');
const CJS = resolve(process.cwd(), 'dist/cjs');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js') || p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// './x' -> './x.js' (file) or './x/index.js' (barrel dir). Declaration files
// resolve against their .d.ts siblings but still get runtime '.js' specifiers
// (TypeScript's nodenext resolution expects them in that form).
function fixSpecifier(spec, fileDir, isDts) {
  if (spec.endsWith('.js')) return spec;
  const target = resolve(fileDir, spec);
  const ext = isDts ? '.d.ts' : '.js';
  if (existsSync(target + ext)) return spec + '.js';
  if (existsSync(join(target, 'index' + ext))) return spec + '/index.js';
  return null; // unresolvable — fail the build loudly below
}

let rewrites = 0;
const unresolved = [];

for (const file of walk(ESM)) {
  const isDts = file.endsWith('.d.ts');
  const fileDir = dirname(file);
  let changed = false;
  const src = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => {
      // Skip comment lines — JSDoc example snippets carry specifiers that
      // are documentation, not resolvable imports.
      if (/^\s*(\*|\/\/)/.test(line)) return line;
      return line.replace(
        // static `import`/`export ... from '...'` and side-effect `import '...'`
        /(\b(?:from|import)\s*)(['"])(\.\.?\/[^'"]+)\2/g,
        (full, kw, q, spec) => {
          const fixed = fixSpecifier(spec, fileDir, isDts);
          if (fixed === null) {
            unresolved.push(`${file}: ${spec}`);
            return full;
          }
          if (fixed === spec) return full;
          changed = true;
          rewrites++;
          return `${kw}${q}${fixed}${q}`;
        },
      );
    })
    .join('\n');
  if (changed) writeFileSync(file, src);
}

writeFileSync(join(ESM, 'package.json'), '{"type":"module"}\n');
writeFileSync(join(CJS, 'package.json'), '{"type":"commonjs"}\n');

if (unresolved.length > 0) {
  console.error(`fix-esm-imports: ${unresolved.length} unresolvable specifier(s):`);
  for (const u of unresolved) console.error('  ' + u);
  process.exit(1);
}
console.log(`fix-esm-imports: ${rewrites} specifiers rewritten; type markers stamped`);
