/**
 * End-to-end tests for `move-doc.mjs` against a throwaway fixture "repo" — not a unit test of any one
 * function, but a check that running the real CLI actually rewrites the files on disk the way the
 * inline doc comment promises. Focused on FS-2687 (retargeting `RENAME_MAP` / `guttedAllowlist`),
 * which only shows up end-to-end because `move-doc.mjs`'s `main()` resolves every path off
 * `process.cwd()`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MOVE_DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'move-doc.mjs');

const PAGE_FRONTMATTER = [
  '---',
  "title: 'Old name'",
  "description: 'A fixture page.'",
  "content_type: 'concept'",
  "author: 'test'",
  "sme: 'test'",
  '---',
  '',
  'Body text.',
  '',
].join('\n');

/** A throwaway repo with just enough shape for move-doc.mjs to run: a docs tree, a RENAME_MAP that
 * targets the page under test, and a guttedAllowlist that also names it. */
function fixtureRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'move-doc-e2e-'));
  // move-doc.mjs writes tree-compare.mjs/upstream.config.json back through Prettier, which resolves
  // config from the file's own location. Give the fixture its own, matching the real repo's style, so
  // the assertions below exercise the actual write path instead of Prettier's double-quote default.
  writeFileSync(
    path.join(root, '.prettierrc.json'),
    '{"singleQuote": true, "trailingComma": "all"}',
  );
  const docsDir = path.join(root, 'content', 'docs', 'example');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, 'old-name.mdx'), PAGE_FRONTMATTER);
  writeFileSync(
    path.join(docsDir, 'unrelated.mdx'),
    PAGE_FRONTMATTER.replace('Old name', 'Unrelated'),
  );

  const libDir = path.join(root, 'scripts', 'lib');
  mkdirSync(libDir, { recursive: true });
  const treeCompareSource =
    `export const RENAME_MAP = {\n` +
    `  'upstream/old-name.mdx': 'example/old-name.mdx',\n` +
    `  'upstream/unrelated.mdx': 'example/unrelated.mdx',\n` +
    `};\n`;
  writeFileSync(path.join(libDir, 'tree-compare.mjs'), treeCompareSource);

  const dataDir = path.join(root, 'scripts', 'data');
  mkdirSync(dataDir, { recursive: true });
  const upstreamConfig = {
    repo: '../arbitrum-docs',
    docsSubdir: 'docs',
    absentAllowlist: [],
    guttedAllowlist: [
      {
        path: 'upstream/old-name.mdx',
        reviewedUpstreamSha: 'deadbeef',
        local: 'example/old-name.mdx',
        reason: 'fixture',
      },
      {
        path: 'upstream/unrelated.mdx',
        reviewedUpstreamSha: 'deadbeef',
        local: 'example/unrelated.mdx',
        reason: 'fixture, must stay untouched',
      },
    ],
  };
  writeFileSync(
    path.join(dataDir, 'upstream.config.json'),
    JSON.stringify(upstreamConfig, null, 2) + '\n',
  );

  return {
    root,
    treeComparePath: path.join(libDir, 'tree-compare.mjs'),
    upstreamConfigPath: path.join(dataDir, 'upstream.config.json'),
    fromRel: 'content/docs/example/old-name.mdx',
    toRel: 'content/docs/example/new-name.mdx',
  };
}

test('move-doc retargets the RENAME_MAP value and guttedAllowlist local path for the moved page', (t) => {
  const { root, treeComparePath, upstreamConfigPath, fromRel, toRel } = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const beforeConfig = readFileSync(upstreamConfigPath, 'utf8');
  const beforeTreeCompare = readFileSync(treeComparePath, 'utf8');

  const output = execFileSync('node', [MOVE_DOC, fromRel, toRel], { cwd: root, encoding: 'utf8' });

  // The move itself happened.
  assert.ok(!existsSync(path.join(root, fromRel)), 'old file should no longer exist');
  assert.ok(existsSync(path.join(root, toRel)), 'new file should exist');

  // RENAME_MAP: the moved page's entry retargeted, the unrelated entry untouched.
  const treeCompareNext = readFileSync(treeComparePath, 'utf8');
  assert.match(
    treeCompareNext,
    /'upstream\/old-name\.mdx': 'example\/new-name\.mdx',/,
    'RENAME_MAP value should point at the new local path',
  );
  assert.doesNotMatch(
    treeCompareNext,
    /'example\/old-name\.mdx'/,
    'the old local path should not remain anywhere in RENAME_MAP',
  );
  assert.match(
    treeCompareNext,
    /'upstream\/unrelated\.mdx': 'example\/unrelated\.mdx',/,
    'the unrelated RENAME_MAP entry must be untouched',
  );

  // guttedAllowlist: same story, via the JSON config.
  const configNext = JSON.parse(readFileSync(upstreamConfigPath, 'utf8'));
  assert.equal(configNext.guttedAllowlist[0].local, 'example/new-name.mdx');
  assert.equal(
    configNext.guttedAllowlist[0].reviewedUpstreamSha,
    'deadbeef',
    'other fields intact',
  );
  assert.deepEqual(configNext.guttedAllowlist[1], {
    path: 'upstream/unrelated.mdx',
    reviewedUpstreamSha: 'deadbeef',
    local: 'example/unrelated.mdx',
    reason: 'fixture, must stay untouched',
  });
  assert.deepEqual(configNext.absentAllowlist, [], 'absentAllowlist has no local field to touch');

  // Only the intended fields changed — diff the two files against their originals field-by-field
  // rather than trusting the assertions above alone.
  const beforeData = JSON.parse(beforeConfig);
  beforeData.guttedAllowlist[0].local = 'example/new-name.mdx';
  assert.deepEqual(configNext, beforeData, 'no other field in upstream.config.json changed');

  const expectedTreeCompare = beforeTreeCompare.replace(
    "'upstream/old-name.mdx': 'example/old-name.mdx',",
    "'upstream/old-name.mdx': 'example/new-name.mdx',",
  );
  assert.equal(treeCompareNext, expectedTreeCompare, 'no other line in tree-compare.mjs changed');

  // The CLI reports what it did.
  assert.match(output, /tree-compare\.mjs: retargeted 1 RENAME_MAP value/);
  assert.match(output, /upstream\.config\.json: retargeted 1 guttedAllowlist 'local' path/);
});

test('move-doc --dry-run reports the drift map changes without writing them', (t) => {
  const { root, treeComparePath, upstreamConfigPath, fromRel, toRel } = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const beforeConfig = readFileSync(upstreamConfigPath, 'utf8');
  const beforeTreeCompare = readFileSync(treeComparePath, 'utf8');

  const output = execFileSync('node', [MOVE_DOC, fromRel, toRel, '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.ok(existsSync(path.join(root, fromRel)), 'dry-run must not move the file');
  assert.equal(readFileSync(treeComparePath, 'utf8'), beforeTreeCompare, 'dry-run must not write');
  assert.equal(readFileSync(upstreamConfigPath, 'utf8'), beforeConfig, 'dry-run must not write');

  assert.match(output, /tree-compare\.mjs: retargeted 1 RENAME_MAP value/);
  assert.match(output, /upstream\.config\.json: retargeted 1 guttedAllowlist 'local' path/);
});

test('move-doc is a no-op on the drift maps for a page neither map names', (t) => {
  const { root } = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const docsDir = path.join(root, 'content', 'docs', 'example');
  writeFileSync(path.join(docsDir, 'plain.mdx'), PAGE_FRONTMATTER.replace('Old name', 'Plain'));

  const output = execFileSync(
    'node',
    [MOVE_DOC, 'content/docs/example/plain.mdx', 'content/docs/example/plain-2.mdx'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.doesNotMatch(output, /RENAME_MAP/);
  assert.doesNotMatch(output, /guttedAllowlist/);
});
