/**
 * versioned-docs-check: build-time advisory for the partial page versioning registry
 * (`VERSIONED` in lib/versions-constants.ts, see
 * .claude/docs/superpowers/specs/2026-07-17-partial-versioning-design.md).
 *
 * The versioning registry pins a hand-picked set of documents: each versioned live page and each
 * archived snapshot. Editing any of them affects versioned content (a live page diverging from its
 * archive, or a supposedly-frozen archive being changed), which is easy to do by accident. This
 * script surfaces a loud, impossible-to-miss WARNING, never an error, when a registered document
 * changed.
 *
 * "Changed" means something different depending on where this runs, because a CI checkout has no
 * uncommitted changes to see (FS-2747):
 *
 *   - Locally: working tree + staged vs HEAD, exactly as before. This is what fires in the
 *     terminal before a `git commit`.
 *   - In a `pull_request`-triggered CI run (`GITHUB_BASE_REF` set): the PR base branch's current
 *     tip vs HEAD. `actions/checkout` in this repo's `ci.yml` takes no `fetch-depth`, so it
 *     defaults to a depth-1 checkout with no ancestor history: there is nothing to diff `HEAD`
 *     against locally, which is exactly why the old `git diff HEAD` always came back empty here.
 *     The base tip is fetched fresh, at depth 1, into `refs/remotes/origin/<base>`, and diffed
 *     directly against `HEAD` (a plain two-tree diff, not a merge-base one: depth 1 gives no
 *     shared history to find a merge-base with, and `HEAD` on a `pull_request` run is already a
 *     synthetic merge of the PR head into the current base, so a direct diff against that base's
 *     current tip reports exactly what the PR changed).
 *   - Anywhere else (a direct `push` to `main`, i.e. post-merge, or the base fetch itself
 *     failing): falls back to the local behavior. `push` runs carry no `GITHUB_BASE_REF`, and by
 *     the time one runs, its PR's own `pull_request` run should already have warned, since merges
 *     go through a PR first. A residual gap, not a fix.
 *
 * Warning only: always exits 0 so it never blocks `pnpm build`. The registry invariants that *do*
 * have to hold, every key naming a live page, every archive id free of a colliding child page, are
 * asserted in scripts/versions-routing.test.mjs, which fails.
 *
 *   node scripts/versioned-docs-check.mjs
 */
import { execFileSync } from 'node:child_process';

import { VERSIONS_FILE, pinnedDocuments } from './lib/versions-registry.mjs';

const repoRoot = process.cwd();

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Fetches the PR base branch's tip (depth 1, no shared history needed) into
 * `refs/remotes/origin/<base>` and returns that ref name, or `null` on any failure (no network,
 * no `origin` remote, an unknown base), in which case the caller falls back to the local
 * comparison.
 */
function fetchPrBaseRef(base) {
  try {
    git(['fetch', '--depth=1', 'origin', `${base}:refs/remotes/origin/${base}`]);
    return `refs/remotes/origin/${base}`;
  } catch {
    return null;
  }
}

/**
 * Picks the comparison this run should use: the PR base branch's tip in a `pull_request`-triggered
 * CI run, `HEAD` everywhere else (see the header comment for why). Returns `{ args, label }`,
 * where `args` is the `git diff` positional ref arguments and `label` describes the comparison for
 * the printed output.
 */
function resolveComparison() {
  const base = process.env.GITHUB_BASE_REF;
  if (process.env.GITHUB_ACTIONS === 'true' && base) {
    const ref = fetchPrBaseRef(base);
    if (ref) return { args: [ref, 'HEAD'], label: `${ref} vs HEAD (PR base fetched fresh)` };
    return { args: ['HEAD'], label: 'HEAD (working tree), could not fetch PR base, falling back' };
  }
  return { args: ['HEAD'], label: 'HEAD (working tree + staged vs HEAD)' };
}

/**
 * Repo-relative paths (from `docs`) that changed under `comparison`, or `null` when git is
 * unavailable, in which case the check is skipped silently.
 */
function modifiedDocs(docs, comparison) {
  if (docs.length === 0) return [];
  try {
    const out = git(['diff', '--name-only', ...comparison.args, '--', ...docs]);
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

function printWarning(modified, comparison) {
  const yellow = (s) => paint('33;1', s);
  const banner = (s) => paint('30;43;1', s); // black text on yellow background
  const line = '─'.repeat(74);
  const changedLine = `(${VERSIONS_FILE}) and changed, per ${comparison.label}:`;

  console.warn('');
  console.warn(banner('  ⚠  VERSIONED DOCUMENT MODIFIED — please review before building        '));
  console.warn(yellow(`┌${line}┐`));
  console.warn(
    yellow('│ ') +
      'The following document(s) are pinned by the versioning registry'.padEnd(72) +
      yellow(' │'),
  );
  console.warn(yellow('│ ') + changedLine.slice(0, 72).padEnd(72) + yellow(' │'));
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

const comparison = resolveComparison();
const docs = pinnedDocuments(repoRoot);
const modified = modifiedDocs(docs, comparison);
console.log(`versioned-docs-check: comparing ${comparison.label}`);
if (modified && modified.length > 0) {
  printWarning(modified, comparison);
}
