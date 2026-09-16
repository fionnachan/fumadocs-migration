/**
 * versioned-docs-check — build-time advisory for the partial page versioning registry
 * (`VERSIONED` in lib/versions-constants.ts, see
 * .claude/docs/superpowers/specs/2026-07-17-partial-versioning-design.md).
 *
 * The versioning registry pins a hand-picked set of documents: each versioned live page and each
 * archived snapshot. Editing any of them affects versioned content (a live page diverging from its
 * archive, or a supposedly-frozen archive being changed), which is easy to do by accident. This
 * script surfaces a loud, impossible-to-miss WARNING — never an error — when any registered
 * document has uncommitted git changes (working tree + staged, vs HEAD).
 *
 * Warning only: always exits 0 so it never blocks `pnpm build`. The registry invariants that *do*
 * have to hold — every key naming a live page, every archive id free of a colliding child page —
 * are asserted in scripts/versions-routing.test.mjs, which fails.
 *
 *   node scripts/versioned-docs-check.mjs
 */
import { execFileSync } from 'node:child_process';

import { VERSIONS_FILE, pinnedDocuments } from './lib/versions-registry.mjs';

const repoRoot = process.cwd();

/**
 * Repo-relative paths (from `docs`) that have uncommitted changes vs HEAD, or `null` when git is
 * unavailable (e.g. a CI checkout without history) — in which case the check is skipped silently.
 */
function modifiedDocs(docs) {
  if (docs.length === 0) return [];
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...docs], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

const useColor = !process.env.NO_COLOR;
const paint = (codes, s) => (useColor ? `\x1b[${codes}m${s}\x1b[0m` : s);

function printWarning(modified) {
  const yellow = (s) => paint('33;1', s);
  const banner = (s) => paint('30;43;1', s); // black text on yellow background
  const line = '─'.repeat(74);

  console.warn('');
  console.warn(banner('  ⚠  VERSIONED DOCUMENT MODIFIED — please review before building        '));
  console.warn(yellow(`┌${line}┐`));
  console.warn(
    yellow('│ ') +
      'The following document(s) are pinned by the versioning registry'.padEnd(72) +
      yellow(' │'),
  );
  console.warn(
    yellow('│ ') + `(${VERSIONS_FILE}) and have uncommitted changes:`.padEnd(72) + yellow(' │'),
  );
  console.warn(yellow(`│${' '.repeat(74)}│`));
  for (const file of modified) {
    console.warn(yellow('│   • ') + file.padEnd(68) + yellow(' │'));
  }
  console.warn(yellow(`│${' '.repeat(74)}│`));
  console.warn(
    yellow('│ ') +
      'Editing a live page diverges it from its archived version; editing'.padEnd(72) +
      yellow(' │'),
  );
  console.warn(
    yellow('│ ') +
      'an archive changes a snapshot meant to be frozen. Confirm intended.'.padEnd(72) +
      yellow(' │'),
  );
  console.warn(yellow(`└${line}┘`));
  console.warn('');
}

const docs = pinnedDocuments(repoRoot);
const modified = modifiedDocs(docs);
if (modified && modified.length > 0) {
  printWarning(modified);
}
