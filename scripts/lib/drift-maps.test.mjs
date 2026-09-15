import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  TREE_COMPARE_PATH,
  UPSTREAM_CONFIG_PATH,
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

test('updateDriftMaps writes both files and reports notes, only when something changed', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const treeCompareAbs = path.join(root, TREE_COMPARE_PATH);
  const upstreamConfigAbs = path.join(root, UPSTREAM_CONFIG_PATH);
  mkdirSync(path.dirname(treeCompareAbs), { recursive: true });
  mkdirSync(path.dirname(upstreamConfigAbs), { recursive: true });

  writeFileSync(
    treeCompareAbs,
    `export const RENAME_MAP = {\n  'up/moved.mdx': 'local/moved.mdx',\n  'up/other.mdx': 'local/other.mdx',\n};\n`,
  );
  writeFileSync(upstreamConfigAbs, configFixture().replace('moved.mdx', 'local/moved.mdx'));

  const notes = updateDriftMaps(root, 'local/moved.mdx', 'local/moved-new.mdx', false);
  assert.equal(notes.length, 2, `expected two notes, got: ${JSON.stringify(notes)}`);

  const treeCompareNext = readFileSync(treeCompareAbs, 'utf8');
  assert.match(treeCompareNext, /'up\/moved\.mdx': 'local\/moved-new\.mdx',/);
  assert.match(treeCompareNext, /'up\/other\.mdx': 'local\/other\.mdx',/);

  const configNext = JSON.parse(readFileSync(upstreamConfigAbs, 'utf8'));
  assert.equal(configNext.guttedAllowlist[0].local, 'local/moved-new.mdx');
});

test('updateDriftMaps in dry-run mode reports notes but writes nothing', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const treeCompareAbs = path.join(root, TREE_COMPARE_PATH);
  mkdirSync(path.dirname(treeCompareAbs), { recursive: true });
  const original = `export const RENAME_MAP = {\n  'up/moved.mdx': 'local/moved.mdx',\n};\n`;
  writeFileSync(treeCompareAbs, original);

  const notes = updateDriftMaps(root, 'local/moved.mdx', 'local/moved-new.mdx', true);
  assert.equal(notes.length, 1);
  assert.equal(readFileSync(treeCompareAbs, 'utf8'), original, 'dry-run must not write');
});

test('updateDriftMaps reports nothing when neither file is present', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-maps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notes = updateDriftMaps(root, 'local/moved.mdx', 'local/moved-new.mdx', false);
  assert.deepEqual(notes, []);
});
