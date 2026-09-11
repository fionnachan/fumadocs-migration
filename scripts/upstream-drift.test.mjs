import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  RENAME_MAP,
  bodyLineCount,
  buildTreeIndex,
  mapSectionPath,
  normalizeSlug,
  pairTrees,
} from './lib/tree-compare.mjs';
import {
  allowlistedAbsent,
  allowlistedGutted,
  expandHome,
  readUpstreamConfig,
  repoRoot,
  resolveUpstreamTree,
} from './lib/upstream-tree.mjs';

/** Shaped like the checked-in config, so these tests exercise the fields the script actually reads. */
const CONFIG = {
  repo: '../arbitrum-docs',
  docsSubdir: 'docs',
  probePaths: ['../arbitrum-docs', '../../arbitrum-docs', '~/OCL/arbitrum-docs'],
  absentAllowlist: [{ path: 'a/b.mdx', reason: 'because' }],
  guttedAllowlist: [{ path: 'c/d.mdx', local: 'd.mdx', reason: 'also because' }],
};

const ROOT = '/repos/Fumadocs-test';
const CWD = '/somewhere/else';
const HOME = '/home/dev';

/** Resolve against a fake filesystem where only `present` exists. */
function resolve(present, options = {}) {
  const set = new Set(present);
  return resolveUpstreamTree({
    config: CONFIG,
    root: ROOT,
    cwd: CWD,
    home: HOME,
    env: {},
    exists: (p) => set.has(p),
    ...options,
  });
}

test('normalizeSlug strips numeric prefixes, extension and case', () => {
  assert.equal(normalizeSlug('run-arbitrum-node/01-overview.mdx'), 'overview');
  assert.equal(normalizeSlug('a/b/Some-Page.md'), 'somepage');
  assert.equal(normalizeSlug('partials/_my-partial.mdx'), 'mypartial');
});

test('mapSectionPath applies the Tree A -> Tree B section renames', () => {
  assert.equal(mapSectionPath('run-arbitrum-node/overview.mdx'), 'run-a-node/overview.mdx');
  assert.equal(
    mapSectionPath('launch-arbitrum-chain/chain-config/costs/x.mdx'),
    'launch-arbitrum-chain/configuration/costs/x.mdx',
  );
  assert.equal(mapSectionPath('for-devs/oracles/api3/api3.mdx'), 'oracles/api3/api3.mdx');
  assert.equal(mapSectionPath('stylus-by-example/x.mdx'), 'stylus/x.mdx');
});

test('mapSectionPath leaves unmapped sections untouched', () => {
  assert.equal(mapSectionPath('how-arbitrum-works/x.mdx'), 'how-arbitrum-works/x.mdx');
});

test('mapSectionPath applies whole-file renames, and they beat section prefixes', () => {
  assert.equal(
    mapSectionPath('launch-arbitrum-chain/operate/monitoring.mdx'),
    'launch-arbitrum-chain/operate/monitoring-tools-and-considerations.mdx',
  );
  // This one also matches the chain-config -> configuration section prefix; the rename must win.
  assert.equal(
    mapSectionPath('launch-arbitrum-chain/chain-config/sequencer/sequencer-timing-adjustments.mdx'),
    'launch-arbitrum-chain/configuration/sequencer/config-sequencer-timing-adjustments.mdx',
  );
});

test('bodyLineCount excludes frontmatter', () => {
  const src = ['---', 'title: X', '---', '', 'line one', 'line two'].join('\n');
  assert.equal(bodyLineCount(src), 3);
});

test('bodyLineCount handles a file with no frontmatter', () => {
  assert.equal(bodyLineCount('just\ntwo lines'), 2);
});

test('bodyLineCount ignores the trailing empty element from a final newline', () => {
  assert.equal(bodyLineCount('just\ntwo lines\n'), 2);
  assert.equal(bodyLineCount(['---', 'title: X', '---', 'body one', 'body two', ''].join('\n')), 2);
});

test('pairTrees does not let a bare-slug collision mispair a directory-qualified page', () => {
  // Two Tree B files share the same bare slug ("gentleintroduction") in different directories, the
  // exact shape of the real BoLD-vs-Stylus bug: an index keyed on bare slug alone let the second
  // file walked silently clobber the first, so the BoLD page paired against the Stylus page.
  const index = buildTreeIndex([
    'stylus/gentle-introduction.mdx',
    'how-arbitrum-works/bold/gentle-introduction.mdx',
  ]);
  const paired = pairTrees(index, ['how-arbitrum-works/bold/gentle-introduction.mdx']);
  assert.equal(
    paired.get('how-arbitrum-works/bold/gentle-introduction.mdx'),
    'how-arbitrum-works/bold/gentle-introduction.mdx',
  );
});

test('pairTrees refuses an ambiguous bare-slug fallback', () => {
  // Queried from a Tree A directory with no directory-qualified counterpart at all: the bare slug
  // is ambiguous across two Tree B candidates, so it must report ABSENT rather than guess.
  const index = buildTreeIndex([
    'stylus/gentle-introduction.mdx',
    'how-arbitrum-works/bold/gentle-introduction.mdx',
  ]);
  const paired = pairTrees(index, ['unmatched-dir/gentle-introduction.mdx']);
  assert.equal(paired.get('unmatched-dir/gentle-introduction.mdx'), null);
});

test('pairTrees still applies whole-file renames via mapSectionPath', () => {
  const index = buildTreeIndex([
    'launch-arbitrum-chain/operate/monitoring-tools-and-considerations.mdx',
  ]);
  const paired = pairTrees(index, ['launch-arbitrum-chain/operate/monitoring.mdx']);
  assert.equal(
    paired.get('launch-arbitrum-chain/operate/monitoring.mdx'),
    'launch-arbitrum-chain/operate/monitoring-tools-and-considerations.mdx',
  );
});

// --- upstream tree resolution -------------------------------------------------------------------
// The bug these cover: upstream-drift ignored upstream.config.json entirely and fell back to one
// contributor's absolute path, so `pnpm drift` with no flags failed on every other checkout.

test('resolveUpstreamTree honours --tree-a first, as a path to the docs tree itself', () => {
  const got = resolve(['/somewhere/else/legacy/docs', '/repos/arbitrum-docs/docs'], {
    argv: ['--tree-a', 'legacy/docs'],
  });
  assert.equal(got.source, '--tree-a');
  assert.equal(got.docs, '/somewhere/else/legacy/docs');
  // The repo is the docs tree's parent, which is what the git-freshness check is run against.
  assert.equal(got.repo, '/somewhere/else/legacy');
});

test('resolveUpstreamTree falls to UPSTREAM_DOCS_REPO, which names the repo root', () => {
  const got = resolve(['/somewhere/else/clone/docs'], {
    env: { UPSTREAM_DOCS_REPO: 'clone' },
  });
  assert.equal(got.source, 'UPSTREAM_DOCS_REPO');
  assert.equal(got.repo, '/somewhere/else/clone');
  assert.equal(got.docs, '/somewhere/else/clone/docs');
});

test('resolveUpstreamTree prefers --tree-a over UPSTREAM_DOCS_REPO when both resolve', () => {
  const got = resolve(['/somewhere/else/flag/docs', '/somewhere/else/env/docs'], {
    argv: ['--tree-a', 'flag/docs'],
    env: { UPSTREAM_DOCS_REPO: 'env' },
  });
  assert.equal(got.source, '--tree-a');
});

test('resolveUpstreamTree resolves config.repo against the repo root, not the cwd', () => {
  const got = resolve(['/repos/arbitrum-docs/docs']);
  assert.equal(got.source, 'config.repo');
  assert.equal(got.docs, '/repos/arbitrum-docs/docs');
  // The cwd is deliberately somewhere unrelated; resolving there would have missed this checkout.
  assert.ok(!got.docs.startsWith(CWD));
});

test('resolveUpstreamTree falls through to probePaths in order when config.repo is absent', () => {
  // The worktree case: ../arbitrum-docs does not exist, ../../arbitrum-docs does.
  const got = resolve(['/arbitrum-docs/docs']);
  assert.equal(got.source, 'config.probePaths (../../arbitrum-docs)');
  assert.equal(got.docs, '/arbitrum-docs/docs');
});

test('resolveUpstreamTree expands a leading ~ in a probe path', () => {
  const got = resolve(['/home/dev/OCL/arbitrum-docs/docs']);
  assert.equal(got.source, 'config.probePaths (~/OCL/arbitrum-docs)');
  assert.equal(got.repo, '/home/dev/OCL/arbitrum-docs');
});

test('resolveUpstreamTree returns null rather than guessing when nothing exists', () => {
  assert.equal(resolve([]), null);
});

test('resolveUpstreamTree ignores a --tree-a with no value', () => {
  const got = resolve(['/repos/arbitrum-docs/docs'], { argv: ['--tree-a'] });
  assert.equal(got.source, 'config.repo');
});

test('expandHome only expands a leading ~ segment', () => {
  assert.equal(expandHome('~/x', '/home/dev'), '/home/dev/x');
  assert.equal(expandHome('~', '/home/dev'), '/home/dev');
  assert.equal(expandHome('../x', '/home/dev'), '../x');
  // A path that merely starts with the character must be left alone.
  assert.equal(expandHome('~weird/x', '/home/dev'), '~weird/x');
});

// --- absent allowlist ---------------------------------------------------------------------------

test('allowlistedAbsent reads the configured paths', () => {
  assert.deepEqual([...allowlistedAbsent(CONFIG)], ['a/b.mdx']);
});

test('allowlistedAbsent is empty when the config has no allowlist', () => {
  assert.equal(allowlistedAbsent({}).size, 0);
});

test('the checked-in config absent-allowlists only the content map', () => {
  // Content maps were replaced by index.mdx + meta.json by design, so upstream's has no counterpart.
  // 01-stf-gentle-intro sat here too until the pairing fix showed it is a plain rename to
  // deep-dives/stf.mdx at ratio 1.74, which RENAME_MAP now states outright. An exemption that turns
  // out to be a rename belongs in the rename map, where the pages get compared rather than skipped.
  // Anything else appearing here is a real gap being silenced and should fail this test.
  const config = readUpstreamConfig();
  assert.deepEqual([...allowlistedAbsent(config)], ['node-running/sequencer-content-map.mdx']);
  for (const entry of config.absentAllowlist) {
    assert.ok(entry.reason, `allowlist entry ${entry.path} must carry a reason`);
  }
});

test('the checked-in config still points at the sibling checkout from both layouts', () => {
  // ../arbitrum-docs works from the main checkout, ../../arbitrum-docs from a worktree one level
  // deeper. Dropping either breaks `pnpm drift` for half the team.
  const { probePaths } = readUpstreamConfig();
  assert.ok(probePaths.includes('../arbitrum-docs'));
  assert.ok(probePaths.includes('../../arbitrum-docs'));
});

test('allowlistedGutted reads its own list, not the absent one', () => {
  assert.deepEqual([...allowlistedGutted(CONFIG)], ['c/d.mdx']);
  // The two lists suppress different verdicts and must never bleed into each other: a page exempted
  // from ABSENT was never ported, a page exempted from GUTTED was ported in full.
  assert.equal(allowlistedGutted(CONFIG).has('a/b.mdx'), false);
  assert.equal(allowlistedAbsent(CONFIG).has('c/d.mdx'), false);
});

test('allowlistedGutted is empty when the config has no gutted allowlist', () => {
  assert.equal(allowlistedGutted({}).size, 0);
});

test('the checked-in config allowlists exactly the four gutted false positives', () => {
  // All three are card-landing rewrites or import-boilerplate line gaps confirmed at content parity
  // by side-by-side review. Anything else here is real content loss being silenced.
  const config = readUpstreamConfig();
  assert.deepEqual(
    [...allowlistedGutted(config)].sort(),
    [
      'for-devs/dev-tools-and-resources/chain-info.mdx',
      'for-devs/oracles/oracles-content-map.mdx',
      'get-started/overview.mdx',
      'launch-arbitrum-chain/overview/introduction.mdx',
    ],
  );
  for (const entry of config.guttedAllowlist) {
    assert.ok(entry.reason, `gutted allowlist entry ${entry.path} must carry a reason`);
    assert.ok(entry.local, `gutted allowlist entry ${entry.path} must name its local counterpart`);
  }
});

test('the two upstream renames out of extend-the-protocol resolve to their local pages', () => {
  // Upstream moved both out of extend-the-protocol after the port; without these the drift report
  // called two pages that exist here ABSENT.
  assert.equal(
    mapSectionPath('launch-arbitrum-chain/extend-the-protocol/da-api-guide.mdx'),
    'launch-arbitrum-chain/integrations/da-api-integration-guide.mdx',
  );
  assert.equal(
    mapSectionPath('launch-arbitrum-chain/extend-the-protocol/precompiles.mdx'),
    'launch-arbitrum-chain/configuration/core/customize-precompile.mdx',
  );
});

test('every RENAME_MAP and guttedAllowlist target is a file that exists in content/docs', () => {
  // A rename or exemption pointing at a path that does not exist silently stops suppressing
  // anything, and the report quietly regrows a false positive nobody notices.
  const root = path.join(repoRoot, 'content', 'docs');
  for (const target of Object.values(RENAME_MAP)) {
    assert.ok(existsSync(path.join(root, target)), `RENAME_MAP target missing: ${target}`);
  }
  for (const entry of readUpstreamConfig().guttedAllowlist) {
    assert.ok(
      existsSync(path.join(root, entry.local)),
      `guttedAllowlist local target missing: ${entry.local}`,
    );
  }
});

// --- whole-tree pairing --------------------------------------------------------------------------
// The bug these cover: upstream keeps a concept page and a how-to page under the same basename
// (arbos, batchposter/batch-poster, stf). Resolved one path at a time, the concept page paired by
// directory and the how-to page then grabbed the SAME local file through the bare-slug fallback.
// The report called three ported pages GUTTED at 0.12, 0.20 and 0.48 purely because it was measuring
// a how-to against a concept page, and hid three unported how-tos behind those ratios.

test('pairTrees lets a directory match claim its Tree B file', () => {
  const index = buildTreeIndex(['how-arbitrum-works/deep-dives/arbos.mdx']);
  const paired = pairTrees(index, [
    'how-arbitrum-works/deep-dives/arbos.mdx',
    'some-other-section/arbos.mdx',
  ]);
  assert.equal(paired.get('how-arbitrum-works/deep-dives/arbos.mdx'), 'how-arbitrum-works/deep-dives/arbos.mdx');
  // The second upstream page must report ABSENT rather than stealing the first one's counterpart.
  assert.equal(paired.get('some-other-section/arbos.mdx'), null);
});

test('pairTrees does not depend on the order the Tree A paths arrive in', () => {
  const index = buildTreeIndex(['how-arbitrum-works/deep-dives/arbos.mdx']);
  const forwards = pairTrees(index, [
    'how-arbitrum-works/deep-dives/arbos.mdx',
    'some-other-section/arbos.mdx',
  ]);
  const backwards = pairTrees(index, [
    'some-other-section/arbos.mdx',
    'how-arbitrum-works/deep-dives/arbos.mdx',
  ]);
  assert.deepEqual([...forwards].sort(), [...backwards].sort());
});

test('pairTrees still pairs a genuine cross-section move', () => {
  // Nothing else claims the target, so the bare-slug fallback is still allowed to do its job.
  const index = buildTreeIndex(['new-section/unique-page-name.mdx']);
  const paired = pairTrees(index, ['old-section/unique-page-name.mdx']);
  assert.equal(paired.get('old-section/unique-page-name.mdx'), 'new-section/unique-page-name.mdx');
});

test('pairTrees gives a Tree B file to at most one Tree A file', () => {
  // Two unmatched Tree A paths, one candidate. Exactly one may win; the other reports ABSENT.
  const index = buildTreeIndex(['somewhere/thing.mdx']);
  const paired = pairTrees(index, ['a/thing.mdx', 'b/thing.mdx']);
  const winners = [...paired.values()].filter((v) => v === 'somewhere/thing.mdx');
  assert.equal(winners.length, 1);
  assert.equal([...paired.values()].filter((v) => v === null).length, 1);
});

test('the upstream pages that share a basename with a deep-dive now map to their own local pages', () => {
  // All four were mispaired before: three surfaced as bogus GUTTED ratios, and gas-optimization
  // paired against the unrelated Stylus page quietly enough that it produced no finding at all.
  const cases = {
    'launch-arbitrum-chain/extend-the-protocol/arbos.mdx':
      'launch-arbitrum-chain/configuration/core/customize-arbos.mdx',
    'launch-arbitrum-chain/extend-the-protocol/stf.mdx':
      'launch-arbitrum-chain/configuration/core/customize-stf.mdx',
    'launch-arbitrum-chain/run-a-node/batch-poster.mdx': 'run-a-node/run-batch-poster.mdx',
    'launch-arbitrum-chain/chain-config/costs/gas-optimization.mdx':
      'launch-arbitrum-chain/configuration/costs/gas-optimization-tools.mdx',
    // The gentle intro was renamed to stf.mdx and expanded, so it is a rename and not a gap.
    'how-arbitrum-works/deep-dives/01-stf-gentle-intro.mdx': 'how-arbitrum-works/deep-dives/stf.mdx',
  };
  for (const [upstream, local] of Object.entries(cases)) {
    assert.equal(mapSectionPath(upstream), local, `${upstream} should map to ${local}`);
  }
});
