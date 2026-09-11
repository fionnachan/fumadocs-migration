/**
 * upstream-drift — compare this repo against the legacy arbitrum-docs tree.
 *
 * Usage:
 *   pnpm drift                       # human report; exits 1 if anything is absent or gutted
 *   pnpm drift --json                # JSON to stdout; exits 0
 *   pnpm drift --tree-a <path>       # override the legacy tree location
 *
 * With no flag the upstream checkout is located by `scripts/lib/upstream-tree.mjs`, which reads
 * `scripts/data/upstream.config.json`. That module documents the resolution order.
 *
 * Reports three things:
 *   ABSENT  a legacy page with no counterpart here
 *   GUTTED  a page present here whose body is under 70% of the legacy body
 *   Each ABSENT item is labelled DRIFT (added upstream after the port window closed, never in scope)
 *   or MISS (existed before the port window closed and should have been ported).
 *
 * Pairing depends on `RENAME_MAP` in lib/tree-compare.mjs. A page ported under a new name that
 * isn't in that map surfaces here as ABSENT (looks unported) instead of pairing with its real
 * counterpart, so add an entry there whenever a port renames a file — otherwise the report fills
 * with false positives and stops being read.
 *
 * Two allowlists in the config suppress a verdict, and they are deliberately not one list:
 *   absentAllowlist  the page was never ported, and that was the decision
 *   guttedAllowlist  the page WAS ported at parity; only the line count disagrees, because
 *                    Docusaurus imports and inline grid boilerplate do not survive the port
 * Every entry carries its reason. Suppressed pages are counted and listed under ALLOWED rather than
 * hidden. An absent-exempt page is still compared for GUTTED when a counterpart exists, so an
 * exemption can never hide content loss in the page that absorbed it.
 *
 * Pairing runs over the whole tree at once via `pairTrees`, not file by file, because upstream has
 * pages in two places that share a basename. See that function for what went wrong when it did not.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { baselineVerdict, readBaseline } from './lib/git-freshness.mjs';
import { bodyLineCount, buildTreeIndex, pairTrees } from './lib/tree-compare.mjs';
import {
  allowlistedAbsent,
  allowlistedGutted,
  describeSearchOrder,
  readUpstreamConfig,
  repoRoot,
  resolveUpstreamTree,
} from './lib/upstream-tree.mjs';

const PORT_WINDOW_END = '2026-07-10';
const GUTTED_RATIO = 0.7;
const SKIP = [/^superpowers\//, /^api\//, /(^|\/)partials\//, /^Offchain-pattern-guide\.md$/];

function listDocs(root) {
  const out = [];
  const walk = (abs) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(abs, d.name);
      if (d.isDirectory()) walk(next);
      else if (/\.mdx?$/.test(d.name)) out.push(path.relative(root, next));
    }
  };
  walk(root);
  return out;
}

/**
 * Date a page first appeared upstream. `pathspec` is relative to the repo root, not to the docs
 * tree, so it is derived from the two resolved paths rather than assuming the docs tree is `docs/`.
 */
function addedDate(treeARepo, pathspec) {
  try {
    const out = execFileSync(
      'git',
      ['-C', treeARepo, 'log', '--diff-filter=A', '--format=%ad', '--date=short', '--', pathspec],
      { encoding: 'utf8' },
    ).trim().split('\n');
    return out[out.length - 1] || null;
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const config = readUpstreamConfig();
  const resolved = resolveUpstreamTree({ argv, config });
  // Anchored at the repo root, not the cwd, for the same reason the config paths are: `pnpm drift`
  // has to behave the same whether it is run from the repo root, a subdirectory, or a worktree.
  const treeB = path.join(repoRoot, 'content', 'docs');

  if (!resolved) {
    console.error('upstream-drift: no upstream docs tree found. Looked, in order, at:');
    for (const where of describeSearchOrder(config)) console.error(`  - ${where}`);
    console.error('Clone OffchainLabs/arbitrum-docs next to this repo, or pass --tree-a <path>.');
    process.exitCode = 1;
    return;
  }

  const { docs: treeA, repo: treeARepo } = resolved;
  const absentAllowlist = allowlistedAbsent(config);
  const guttedAllowlist = allowlistedGutted(config);

  const verdict = baselineVerdict(readBaseline(treeARepo));
  for (const w of verdict.warnings) console.error(`upstream-drift: warning: ${treeARepo} ${w}`);
  if (!verdict.ok) {
    console.error(`upstream-drift: refusing to run — ${treeARepo} is not a trustworthy baseline:`);
    for (const b of verdict.blockers) console.error(`  - ${b}`);
    console.error(`Fix: git -C ${treeARepo} pull`);
    console.error('A stale baseline under-reports drift; it does not fail loudly on its own.');
    process.exitCode = 1;
    return;
  }

  const bIndex = buildTreeIndex(listDocs(treeB));
  const candidates = listDocs(treeA).filter((relA) => !SKIP.some((re) => re.test(relA)));
  const paired = pairTrees(bIndex, candidates);

  const absent = [];
  const gutted = [];
  const allowed = [];

  for (const relA of candidates) {
    const relB = paired.get(relA);

    if (!relB) {
      if (absentAllowlist.has(relA)) {
        allowed.push({ verdict: 'ABSENT', treeA: relA });
        continue;
      }
      const added = addedDate(treeARepo, path.relative(treeARepo, path.join(treeA, relA)));
      absent.push({ treeA: relA, added, kind: added && added > PORT_WINDOW_END ? 'DRIFT' : 'MISS' });
      continue;
    }

    const aLines = bodyLineCount(readFileSync(path.join(treeA, relA), 'utf8'));
    const bLines = bodyLineCount(readFileSync(path.join(treeB, relB), 'utf8'));
    if (aLines > 20 && bLines / aLines < GUTTED_RATIO) {
      const ratio = +(bLines / aLines).toFixed(2);
      if (guttedAllowlist.has(relA)) {
        allowed.push({ verdict: 'GUTTED', treeA: relA, treeB: relB, ratio });
        continue;
      }
      gutted.push({ treeA: relA, treeB: relB, aLines, bLines, ratio });
    }
  }

  if (json) {
    console.log(JSON.stringify({ treeA, absent, gutted, allowlisted: allowed }, null, 2));
    return;
  }

  console.log(`upstream-drift: comparing against ${treeA} (via ${resolved.source})`);
  console.log(`upstream-drift: ${absent.length} absent, ${gutted.length} gutted\n`);
  for (const a of [...absent].sort((x, y) => (y.added ?? '').localeCompare(x.added ?? ''))) {
    console.log(`  ABSENT  ${a.kind}  added ${a.added ?? 'unknown'}  ${a.treeA}`);
  }
  if (absent.length && gutted.length) console.log('');
  for (const g of [...gutted].sort((x, y) => x.ratio - y.ratio)) {
    console.log(`  GUTTED  ratio ${g.ratio}  ${g.aLines}->${g.bLines}  ${g.treeA}  ->  ${g.treeB}`);
  }

  if (allowed.length) {
    console.log(
      `\nupstream-drift: ${allowed.length} allowlisted page(s) not reported. See absentAllowlist ` +
        'and guttedAllowlist in scripts/data/upstream.config.json for why each is exempt.',
    );
    const order = [...allowed].sort((x, y) => x.treeA.localeCompare(y.treeA));
    for (const a of order) {
      const suffix = a.verdict === 'GUTTED' ? `  ratio ${a.ratio}  ->  ${a.treeB}` : '';
      console.log(`  ALLOWED  ${a.verdict}  ${a.treeA}${suffix}`);
    }
  }

  if (absent.length || gutted.length) process.exitCode = 1;
}

main();
