#!/usr/bin/env node
/**
 * — Tree-shaking spot-check.
 *
 * For 4 representative connectors (one per channel), bundle each as a
 * single-import esbuild output and assert NONE of a hand-picked set of
 * other connectors' class identifiers appear in the bundle.
 *
 * Spot-checking 4 (not all 34) covers all 4 cross-channel boundaries
 * (most likely tree-shaking failure mode). The full per-connector ceiling
 * is enforced by `size-limit` (see `.size-limit.json`).
 *
 * Run after `npm run build`. Exits 0 on success, 1 on any cross-provider
 * identifier hit.
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

// Spot-check probes: pick one connector per channel; list 5 cross-channel /
// cross-provider class identifiers that MUST NOT appear in the bundle.
const PROBES = [
  {
    name: 'sendgrid',
    importName: 'SendgridEmailConnector',
    forbidden: [
      'MailgunEmailConnector',
      'PostmarkEmailConnector',
      'SnsSmsConnector',
      'FcmPushConnector',
      'SlackChatConnector',
    ],
  },
  {
    name: 'twilio',
    importName: 'TwilioSmsConnector',
    forbidden: [
      'SesEmailConnector',
      'VonageSmsConnector',
      'PlivoSmsConnector',
      'ApnsPushConnector',
      'DiscordChatConnector',
    ],
  },
  {
    name: 'fcm',
    importName: 'FcmPushConnector',
    forbidden: [
      'SendgridEmailConnector',
      'TwilioSmsConnector',
      'ApnsPushConnector',
      'OneSignalPushConnector',
      'WhatsAppChatConnector',
    ],
  },
  {
    name: 'slack',
    importName: 'SlackChatConnector',
    forbidden: [
      'BrevoEmailConnector',
      'MessageBirdSmsConnector',
      'ExpoPushConnector',
      'DiscordChatConnector',
      'TelegramChatConnector',
    ],
  },
];

const root = new URL('..', import.meta.url).pathname;
const entryDist = join(root, 'dist', 'esm', 'index.js');

let mismatches = 0;

for (const probe of PROBES) {
  const dir = await mkdtemp(join(tmpdir(), `thinwrap-treeshake-${probe.name}-`));
  const entryFile = join(dir, 'entry.mjs');
  const outFile = join(dir, 'bundle.js');
  try {
    await writeFile(
      entryFile,
      `import { ${probe.importName} } from '${entryDist}';\nconsole.log(${probe.importName}.name);\n`,
      'utf8',
    );
    await build({
      entryPoints: [entryFile],
      bundle: true,
      minify: false,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile: outFile,
      logLevel: 'silent',
    });
    const bundle = await readFile(outFile, 'utf8');
    for (const ident of probe.forbidden) {
      // Use word boundary regex to avoid matching substrings.
      const re = new RegExp(`\\b${ident}\\b`);
      if (re.test(bundle)) {
        mismatches += 1;
        console.error(
          `tree-shaking regression: ${probe.name} bundle contains ${ident}`,
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (mismatches === 0) {
  console.log(
    `OK — ${PROBES.length} spot-checks passed (no cross-provider identifiers in single-import bundles).`,
  );
  process.exit(0);
}
console.error(`FAIL — ${mismatches} cross-provider identifier(s) detected.`);
process.exit(1);
