// One-off codemod: shorten deep relative imports to their barrel (index.ts)
// when the barrel provably re-exports every imported name.
// Only rewrites `import`/`import type` statements — never `export ... from`.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';

const SRC = resolve(process.cwd(), 'src');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Parse a barrel index.ts → { starFiles: Set<base>, named: Map<exportedName, base> }
function parseBarrel(indexPath) {
  const src = readFileSync(indexPath, 'utf8');
  const starFiles = new Set();
  const named = new Map();
  for (const m of src.matchAll(/export\s+\*\s+from\s+['"]\.\/([^'"]+)['"]/g)) {
    starFiles.add(m[1]);
  }
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]\.\/([^'"]+)['"]/g)) {
    for (const raw of m[1].split(',')) {
      const spec = raw.replace(/\btype\b/, '').trim();
      if (!spec) continue;
      const exported = spec.includes(' as ') ? spec.split(' as ')[1].trim() : spec;
      named.set(exported, m[2]);
    }
  }
  return { starFiles, named };
}

const barrelCache = new Map();
function getBarrel(dir) {
  if (!barrelCache.has(dir)) {
    const idx = join(dir, 'index.ts');
    barrelCache.set(dir, existsSync(idx) ? parseBarrel(idx) : null);
  }
  return barrelCache.get(dir);
}

let totalRewrites = 0;
const changedFiles = new Set();

for (const file of walk(SRC)) {
  let src = readFileSync(file, 'utf8');
  const fileDir = dirname(file);
  let changed = false;

  src = src.replace(
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])(\.[^'"]+)\3/g,
    (full, _typeKw, namesBlob, _q, spec) => {
      const target = resolve(fileDir, spec);
      const targetFile = existsSync(target + '.ts') ? target + '.ts' : null;
      if (!targetFile) return full; // already a dir/barrel import or unresolved
      const targetDir = dirname(targetFile);
      const base = targetFile.slice(targetDir.length + 1).replace(/\.ts$/, '');
      if (base === 'index') return full;
      // Skip same-dir imports (would become a self-barrel cycle) and
      // imports from within the barrel's own subtree.
      if (fileDir === targetDir || (fileDir + sep).startsWith(targetDir + sep)) return full;
      const barrel = getBarrel(targetDir);
      if (!barrel) return full;
      // Every imported (exported-side) name must be re-exported from this base file.
      const names = namesBlob
        .split(',')
        .map((s) => s.replace(/\btype\b/, '').trim())
        .filter(Boolean)
        .map((s) => (s.includes(' as ') ? s.split(' as ')[0].trim() : s));
      const covered = names.every(
        (n) => barrel.starFiles.has(base) || barrel.named.get(n) === base,
      );
      if (!covered) return full;
      let short = relative(fileDir, targetDir).split(sep).join('/');
      if (!short.startsWith('.')) short = './' + short;
      changed = true;
      totalRewrites++;
      return full.replace(spec, short);
    },
  );

  if (changed) {
    writeFileSync(file, src);
    changedFiles.add(relative(process.cwd(), file));
  }
}

console.log(`${totalRewrites} imports shortened in ${changedFiles.size} files`);
for (const f of [...changedFiles].sort()) console.log('  ' + f);
