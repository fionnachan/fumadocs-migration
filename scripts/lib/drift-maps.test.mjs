import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  TREE_COMPARE_PATH,
  UPSTREAM_CONFIG_PATH,
  assertRenameMapRewrite,
  rewriteRenameMapSource,
  rewriteUpstreamConfig,
  updateDriftMaps,
} from './drift-maps.mjs';

// --- rewriteRenameMapSource ----------------------------------------------------------------------

test('rewrites a same-line RENAME_MAP value, leaves the key alone', () => {
  const source = `export const RENAME_MAP = {\n  'for-devs/contribute.mdx': 'contribute.mdx',\n};\n`;
  const { source: next, changed } = rewriteRenameMapSource(source, 'contribute.mdx', 'contrib.mdx');
  assert.equal(changed, 1);
  assert.match(next, /'for-devs\/contribute\.mdx': 'contrib\.mdx',/);
  assert.doesNotMatch(next, /'contribute\.mdx'/);
});

test('rewrites a split-line RENAME_MAP value (long key wraps the value to its own line)', () => {
  // This is the majority shape in the real file: the key is long enough that prettier puts the
  // value on its own line.
  const source =
    `export const RENAME_MAP = {\n` +
    `  'launch-arbitrum-chain/chain-config/costs/aep-overview.mdx':\n` +
    `    'launch-arbitrum-chain/configuration/costs/aep-fee-router-introduction.mdx',\n` +
    `};\n`;
  const { source: next, changed } = rewriteRenameMapSource(
    source,
    'launch-arbitrum-chain/configuration/costs/aep-fee-router-introduction.mdx',
    'launch-arbitrum-chain/configuration/costs/aep-fee-router.mdx',
  );
  assert.equal(changed, 1);
  assert.match(next, /'launch-arbitrum-chain\/configuration\/costs\/aep-fee-router\.mdx',\n};\n$/);
  // The key itself must be untouched.
  assert.match(next, /'launch-arbitrum-chain\/chain-config\/costs\/aep-overview\.mdx':/);
});

test('rewrites the `to` field of a merge:true object value, leaves `merge: true` alone', () => {
  const source =
    `export const RENAME_MAP = {\n` +
    `  'a.mdx': {\n` +
    `    to: 'launch-arbitrum-chain/configuration/sequencer/batch-posting-assertion-control.mdx',\n` +
    `    merge: true,\n` +
    `  },\n` +
    `};\n`;
  const { source: next, changed } = rewriteRenameMapSource(
    source,
    'launch-arbitrum-chain/configuration/sequencer/batch-posting-assertion-control.mdx',
    'launch-arbitrum-chain/configuration/sequencer/batch-posting.mdx',
  );
  assert.equal(changed, 1);
  assert.match(next, /to: 'launch-arbitrum-chain\/configuration\/sequencer\/batch-posting\.mdx',/);
  assert.match(next, /merge: true,/);
});

test('updates both sides of a merge:true rename when both point at the moved page', () => {
  const source =
    `export const RENAME_MAP = {\n` +
    `  'a.mdx': { to: 'shared.mdx', merge: true },\n` +
    `  'b.mdx': { to: 'shared.mdx', merge: true },\n` +
    `};\n`;
  const { source: next, changed } = rewriteRenameMapSource(source, 'shared.mdx', 'shared-new.mdx');
  assert.equal(changed, 2);
  assert.doesNotMatch(next, /'shared\.mdx'/);
  assert.equal((next.match(/'shared-new\.mdx'/g) ?? []).length, 2);
});

test('never rewrites a quoted string used as a RENAME_MAP key, only values', () => {
  // Pathological but guards the key/value distinction: the moved page's new local path happens to
  // collide, textually, with some *upstream* (Tree A) key elsewhere in the map.
  const source =
    `export const RENAME_MAP = {\n` +
    `  'moved.mdx': 'elsewhere.mdx',\n` +
    `  'other-upstream/moved.mdx': 'some-other-local.mdx',\n` +
    `};\n`;
  const { source: next, changed } = rewriteRenameMapSource(
    source,
    'elsewhere.mdx',
    'elsewhere2.mdx',
  );
  assert.equal(changed, 1);
  assert.match(next, /'moved\.mdx': 'elsewhere2\.mdx',/);
  // The unrelated key 'other-upstream/moved.mdx' must survive untouched.
  assert.match(next, /'other-upstream\/moved\.mdx': 'some-other-local\.mdx',/);
});

test('reports zero changes and returns the source unchanged when nothing matches', () => {
  const source = `export const RENAME_MAP = {\n  'a.mdx': 'b.mdx',\n};\n`;
  const { source: next, changed } = rewriteRenameMapSource(source, 'not-there.mdx', 'x.mdx');
  assert.equal(changed, 0);
  assert.equal(next, source);
});

// --- rewriteUpstreamConfig ------------------------------------------------------------------------

function configFixture() {
  return JSON.stringify(
    {
      repo: '../arbitrum-docs',
      absentAllowlist: [{ path: 'a/b.mdx', reviewedUpstreamSha: 'sha1', reason: 'never ported' }],
      guttedAllowlist: [
        { path: 'c/d.mdx', reviewedUpstreamSha: 'sha2', local: 'moved.mdx', reason: 'parity' },
        { path: 'e/f.mdx', reviewedUpstreamSha: 'sha3', local: 'other.mdx', reason: 'unrelated' },
      ],
    },
    null,
    2,
  );
}

test('retargets a matching guttedAllowlist local path and re-serializes with 2-space indent', () => {
  const { text: next, changed } = rewriteUpstreamConfig(
    configFixture(),
    'moved.mdx',
    'moved-new.mdx',
  );
  assert.equal(changed, 1);
  const data = JSON.parse(next);
  assert.equal(data.guttedAllowlist[0].local, 'moved-new.mdx');
  assert.equal(data.guttedAllowlist[0].reviewedUpstreamSha, 'sha2', 'other fields untouched');
  assert.equal(data.guttedAllowlist[0].reason, 'parity');
  // Untouched entry, byte for byte in effect.
  assert.deepEqual(data.guttedAllowlist[1], {
    path: 'e/f.mdx',
    reviewedUpstreamSha: 'sha3',
    local: 'other.mdx',
    reason: 'unrelated',
  });
  assert.deepEqual(data.absentAllowlist, [
    { path: 'a/b.mdx', reviewedUpstreamSha: 'sha1', reason: 'never ported' },
  ]);
  assert.ok(next.endsWith('\n'));
  assert.equal(next.match(/^ {2}"/m)?.[0], '  "', '2-space indent preserved');
});

test('leaves upstream.config.json text byte-identical when nothing matches', () => {
  const original = configFixture();
  const { text: next, changed } = rewriteUpstreamConfig(original, 'not-there.mdx', 'x.mdx');
  assert.equal(changed, 0);
  assert.equal(next, original);
});

// --- updateDriftMaps (file I/O) -------------------------------------------------------------------

test('updateDriftMaps writes both files and reports notes, only when something changed', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const treeCompareAbs = path.join(root, TREE_COMPARE_PATH);
  const upstreamConfigAbs = path.join(root, UPSTREAM_CONFIG_PATH);
  mkdirSync(path.dirname(treeCompareAbs), { recursive: true });
  mkdirSync(path.dirname(upstreamConfigAbs), { recursive: true });
  // `writeFormatted` resolves Prettier config from the file's own location; give the fixture its
  // own, matching the real repo's style, so the write-through-Prettier step is exercised the way it
  // actually runs rather than falling back to Prettier's double-quote default.
  writeFileSync(
    path.join(root, '.prettierrc.json'),
    '{"singleQuote": true, "trailingComma": "all"}',
  );

  writeFileSync(
    treeCompareAbs,
    `export const RENAME_MAP = {\n  'up/moved.mdx': 'local/moved.mdx',\n  'up/other.mdx': 'local/other.mdx',\n};\n`,
  );
  writeFileSync(upstreamConfigAbs, configFixture().replace('moved.mdx', 'local/moved.mdx'));

  const notes = await updateDriftMaps(root, 'local/moved.mdx', 'local/moved-new.mdx', false);
  assert.equal(notes.length, 2, `expected two notes, got: ${JSON.stringify(notes)}`);

  const treeCompareNext = readFileSync(treeCompareAbs, 'utf8');
  assert.match(treeCompareNext, /'up\/moved\.mdx': 'local\/moved-new\.mdx',/);
  assert.match(treeCompareNext, /'up\/other\.mdx': 'local\/other\.mdx',/);

  const configNext = JSON.parse(readFileSync(upstreamConfigAbs, 'utf8'));
  assert.equal(configNext.guttedAllowlist[0].local, 'local/moved-new.mdx');
});

test('updateDriftMaps in dry-run mode reports notes but writes nothing', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const treeCompareAbs = path.join(root, TREE_COMPARE_PATH);
  mkdirSync(path.dirname(treeCompareAbs), { recursive: true });
  const original = `export const RENAME_MAP = {\n  'up/moved.mdx': 'local/moved.mdx',\n};\n`;
  writeFileSync(treeCompareAbs, original);

  const notes = await updateDriftMaps(root, 'local/moved.mdx', 'local/moved-new.mdx', true);
  assert.equal(notes.length, 1);
  assert.equal(readFileSync(treeCompareAbs, 'utf8'), original, 'dry-run must not write');
});

test('updateDriftMaps reports nothing when neither file is present', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notes = await updateDriftMaps(root, 'local/moved.mdx', 'local/moved-new.mdx', false);
  assert.deepEqual(notes, []);
});

// --- the rewrite stays inside RENAME_MAP -----------------------------------------------------------

// `tree-compare.mjs` declares SECTION_MAP above RENAME_MAP, and its *values* are bare section
// prefixes: 'stylus', 'oracles', 'run-a-node'. A whole-file regex for a top-level page (with or
// without its extension) rewrites those too, silently remapping an entire upstream section while the
// CLI reports it as a RENAME_MAP change. No such top-level page exists today, which is exactly why
// this needs a test: the bug would land the day someone adds `content/docs/stylus.mdx`.
const SECTION_AND_RENAME_FIXTURE =
  `export const SECTION_MAP = {\n` +
  `  'for-devs/oracles': 'oracles',\n` +
  `  'run-arbitrum-node': 'run-a-node',\n` +
  `  'stylus-by-example': 'stylus',\n` +
  `};\n` +
  `\n` +
  `export const RENAME_MAP = {\n` +
  `  'up/keep.mdx': 'keep.mdx',\n` +
  `};\n`;

for (const page of ['stylus.mdx', 'oracles.mdx', 'run-a-node.mdx']) {
  test(`never rewrites a SECTION_MAP value when moving top-level ${page}`, () => {
    const { source: next, changed } = rewriteRenameMapSource(
      SECTION_AND_RENAME_FIXTURE,
      page,
      `moved/${page}`,
    );
    assert.equal(changed, 0, `${page} must not match anything outside RENAME_MAP`);
    assert.equal(next, SECTION_AND_RENAME_FIXTURE, 'source must be byte-identical');
  });
}

test('never rewrites a SECTION_MAP value in the real tree-compare.mjs', () => {
  const real = readFileSync(path.join(import.meta.dirname, '..', '..', TREE_COMPARE_PATH), 'utf8');
  for (const page of ['stylus.mdx', 'oracles.mdx', 'run-a-node.mdx', 'third-party-docs.mdx']) {
    const { source: next, changed } = rewriteRenameMapSource(real, page, `moved/${page}`);
    assert.equal(changed, 0, `moving ${page} must not touch the real file`);
    assert.equal(next, real);
  }
});

test('rewrites a RENAME_MAP value that a SECTION_MAP value also spells, without touching SECTION_MAP', () => {
  // The value 'stylus' appears in SECTION_MAP; 'stylus.mdx' is a legitimate RENAME_MAP target.
  const source =
    `export const SECTION_MAP = {\n  'stylus-by-example': 'stylus',\n};\n\n` +
    `export const RENAME_MAP = {\n  'up/stylus.mdx': 'stylus.mdx',\n};\n`;
  const { source: next, changed } = rewriteRenameMapSource(
    source,
    'stylus.mdx',
    'stylus/index.mdx',
  );
  assert.equal(changed, 1);
  assert.match(next, /'stylus-by-example': 'stylus',/, 'SECTION_MAP untouched');
  assert.match(next, /'up\/stylus\.mdx': 'stylus\/index\.mdx',/);
});

// --- a missed textual match is loud, not silent ----------------------------------------------------

test('assertRenameMapRewrite passes on the real tree-compare.mjs for a target it names', async () => {
  const real = path.join(import.meta.dirname, '..', '..', TREE_COMPARE_PATH);
  const { RENAME_MAP } = await import(pathToFileURL(real).href);
  const [, sample] = Object.entries(RENAME_MAP)
    .map(([k, v]) => [k, typeof v === 'string' ? v : v.to])
    .find(([, v]) => typeof v === 'string');
  const { changed } = rewriteRenameMapSource(readFileSync(real, 'utf8'), sample, 'x/y.mdx');
  const warnings = await assertRenameMapRewrite(real, sample, 'x/y.mdx', changed);
  assert.deepEqual(warnings, [], 'no collision expected against a fresh path');
});

test('updateDriftMaps throws when a double-quoted RENAME_MAP makes the textual rewrite miss', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const treeCompareAbs = path.join(root, TREE_COMPARE_PATH);
  mkdirSync(path.dirname(treeCompareAbs), { recursive: true });
  // Reformatted to double quotes: still a valid module naming the moved page, but invisible to the
  // single-quote regex. Before the cross-check this reported "no entry" and left the stale path.
  writeFileSync(
    treeCompareAbs,
    `export const RENAME_MAP = {\n  "up/moved.mdx": "local/moved.mdx",\n};\n`,
  );

  await assert.rejects(
    () => updateDriftMaps(root, 'local/moved.mdx', 'local/moved-new.mdx', false),
    (err) => {
      assert.match(err.message, /changed 0 value\(s\) but the parsed map names it 1 time\(s\)/);
      assert.match(err.message, /local\/moved\.mdx/, 'names the offending path');
      return true;
    },
  );
});

// --- nothing is written unless every rewrite succeeded ---------------------------------------------

test('updateDriftMaps writes neither map when the RENAME_MAP cross-check fails', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const treeCompareAbs = path.join(root, TREE_COMPARE_PATH);
  const upstreamConfigAbs = path.join(root, UPSTREAM_CONFIG_PATH);
  mkdirSync(path.dirname(treeCompareAbs), { recursive: true });
  mkdirSync(path.dirname(upstreamConfigAbs), { recursive: true });

  const treeCompareBefore = `export const RENAME_MAP = {\n  "up/moved.mdx": "local/moved.mdx",\n};\n`;
  const configBefore = configFixture().replace('moved.mdx', 'local/moved.mdx');
  writeFileSync(treeCompareAbs, treeCompareBefore);
  writeFileSync(upstreamConfigAbs, configBefore);

  await assert.rejects(() =>
    updateDriftMaps(root, 'local/moved.mdx', 'local/moved-new.mdx', false),
  );
  // The config rewrite would have succeeded on its own; the point is that it is not written either.
  assert.equal(readFileSync(treeCompareAbs, 'utf8'), treeCompareBefore);
  assert.equal(readFileSync(upstreamConfigAbs, 'utf8'), configBefore);
});

// --- a move onto an existing RENAME_MAP target warns -----------------------------------------------

test('updateDriftMaps warns when the destination is already another entry RENAME_MAP target', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const treeCompareAbs = path.join(root, TREE_COMPARE_PATH);
  mkdirSync(path.dirname(treeCompareAbs), { recursive: true });
  writeFileSync(
    path.join(root, '.prettierrc.json'),
    '{"singleQuote": true, "trailingComma": "all"}',
  );
  writeFileSync(
    treeCompareAbs,
    `export const RENAME_MAP = {\n  'up/a.mdx': 'local/a.mdx',\n  'up/b.mdx': 'local/b.mdx',\n};\n`,
  );

  const notes = await updateDriftMaps(root, 'local/a.mdx', 'local/b.mdx', false);
  assert.equal(notes.length, 2, JSON.stringify(notes));
  assert.match(notes[1], /WARNING/);
  assert.match(notes[1], /'up\/b\.mdx'/, 'names the entry already claiming the destination');
  assert.match(notes[1], /merge: true/);
});
