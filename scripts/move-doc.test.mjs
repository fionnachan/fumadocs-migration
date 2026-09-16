/**
 * End-to-end tests for `move-doc.mjs` against a throwaway fixture "repo" — not a unit test of any one
 * function, but a check that running the real CLI actually rewrites the files on disk the way the
 * inline doc comment promises. Focused on the two map-retargeting steps — FS-2687's `RENAME_MAP` /
 * `guttedAllowlist` and FS-2697's `MANUAL_DESTINATIONS` / `SECTION_LANDINGS` — which only show up
 * end-to-end because `move-doc.mjs`'s `main()` resolves every path off `process.cwd()`, and whose
 * ordering (each can refuse, so each must run after everything that must not be lost) is a property
 * only a full run can pin.
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
 * targets the page under test, a guttedAllowlist that also names it, and a legacy-redirects module
 * whose `MANUAL_DESTINATIONS` and `SECTION_LANDINGS` both point at its URL.
 *
 * `doubleQuoted` writes the same maps with double quotes, invisible to the single-quote-only textual
 * rewrite, so the cross-check aborts that step. That is the only way to reach the failure path end to
 * end. It is per-step (`drift` / `legacy`), because which step aborts decides what has already landed.
 */
function fixtureRepo({ doubleQuoted = false, legacyDoubleQuoted = false } = {}) {
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
  const q = doubleQuoted ? '"' : "'";
  const treeCompareSource =
    `export const RENAME_MAP = {\n` +
    `  ${q}upstream/old-name.mdx${q}: ${q}example/old-name.mdx${q},\n` +
    `  ${q}upstream/unrelated.mdx${q}: ${q}example/unrelated.mdx${q},\n` +
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

  // The legacy-redirect overlay: hand-written legacy URL -> this site's page, stored as site URLs
  // rather than file paths. Nothing here reads an upstream checkout, which is the whole point —
  // `move-doc` retargets these maps from the two exports alone.
  const lq = legacyDoubleQuoted ? '"' : "'";
  writeFileSync(
    path.join(libDir, 'legacy-redirects.mjs'),
    `export const SECTION_RENAMES = [[${lq}/legacy-example${lq}, ${lq}/example${lq}]];\n` +
      `\n` +
      `export const MANUAL_DESTINATIONS = new Map([\n` +
      `  [${lq}/legacy/old-name${lq}, ${lq}/docs/example/old-name${lq}],\n` +
      `  [${lq}/legacy/anchored${lq}, ${lq}/docs/example/old-name#a-section${lq}],\n` +
      `  [${lq}/legacy/unrelated${lq}, ${lq}/docs/example/unrelated${lq}],\n` +
      `]);\n` +
      `\n` +
      `export const SECTION_LANDINGS = new Map([\n` +
      `  [${lq}/legacy/never-ported${lq}, ${lq}/docs/example/old-name${lq}],\n` +
      `]);\n`,
  );

  return {
    root,
    treeComparePath: path.join(libDir, 'tree-compare.mjs'),
    upstreamConfigPath: path.join(dataDir, 'upstream.config.json'),
    legacyRedirectsPath: path.join(libDir, 'legacy-redirects.mjs'),
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

test('an aborted drift step still leaves the redirect behind, and writes neither map', (t) => {
  // The drift step is deliberately last, because it is the one step that can refuse. Nothing else
  // pins that ordering, so moving it back ahead of the redirect would silently cost a page its
  // redirect on every abort. This is the regression test for the ordering, not just for the abort.
  const { root, treeComparePath, upstreamConfigPath, fromRel, toRel } = fixtureRepo({
    doubleQuoted: true,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const beforeConfig = readFileSync(upstreamConfigPath, 'utf8');
  const beforeTreeCompare = readFileSync(treeComparePath, 'utf8');

  let failure;
  try {
    execFileSync('node', [MOVE_DOC, fromRel, toRel], { cwd: root, encoding: 'utf8' });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'move-doc must exit non-zero when the RENAME_MAP cross-check fails');
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /the parsed map names it 1 time\(s\)/);

  // Neither map written: the step is all-or-nothing, and the config rewrite would have succeeded.
  assert.equal(readFileSync(treeComparePath, 'utf8'), beforeTreeCompare);
  assert.equal(readFileSync(upstreamConfigPath, 'utf8'), beforeConfig);

  // Everything before the drift step landed, the redirect included.
  assert.ok(existsSync(path.join(root, toRel)), 'the move itself still happened');
  const redirects = readFileSync(path.join(root, 'redirects.config.mjs'), 'utf8');
  assert.match(
    redirects,
    /source: '\/docs\/example\/old-name', destination: '\/docs\/example\/new-name'/,
  );
});

// --- FS-2697: the legacy destination overlay ------------------------------------------------------

test('move-doc retargets MANUAL_DESTINATIONS and SECTION_LANDINGS for the moved page', (t) => {
  const { root, legacyRedirectsPath, fromRel, toRel } = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const before = readFileSync(legacyRedirectsPath, 'utf8');
  const output = execFileSync('node', [MOVE_DOC, fromRel, toRel], { cwd: root, encoding: 'utf8' });

  // Byte-for-byte the original with the three destinations retargeted and nothing else: the key,
  // the unrelated entry, the `#a-section` anchor and SECTION_RENAMES all survive.
  assert.equal(
    readFileSync(legacyRedirectsPath, 'utf8'),
    before.replaceAll("'/docs/example/old-name", "'/docs/example/new-name"),
    'only the destinations naming the moved page changed',
  );

  assert.match(output, /legacy-redirects\.mjs: retargeted 2 MANUAL_DESTINATIONS destination\(s\)/);
  assert.match(output, /legacy-redirects\.mjs: retargeted 1 SECTION_LANDINGS destination\(s\)/);
  assert.match(
    output,
    /pnpm redirects:legacy/,
    'tells the mover the generated file is a hop stale',
  );
});

test('move-doc --dry-run reports the legacy destination changes without writing them', (t) => {
  const { root, legacyRedirectsPath, fromRel, toRel } = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const before = readFileSync(legacyRedirectsPath, 'utf8');
  const output = execFileSync('node', [MOVE_DOC, fromRel, toRel, '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(readFileSync(legacyRedirectsPath, 'utf8'), before, 'dry-run must not write');
  assert.match(output, /legacy-redirects\.mjs: retargeted 2 MANUAL_DESTINATIONS destination\(s\)/);
  assert.match(output, /legacy-redirects\.mjs: retargeted 1 SECTION_LANDINGS destination\(s\)/);
});

test('move-doc is a no-op on the legacy maps for a page neither map names', (t) => {
  const { root, legacyRedirectsPath } = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const docsDir = path.join(root, 'content', 'docs', 'example');
  writeFileSync(path.join(docsDir, 'plain.mdx'), PAGE_FRONTMATTER.replace('Old name', 'Plain'));
  const before = readFileSync(legacyRedirectsPath, 'utf8');

  const output = execFileSync(
    'node',
    [MOVE_DOC, 'content/docs/example/plain.mdx', 'content/docs/example/plain-2.mdx'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.doesNotMatch(output, /MANUAL_DESTINATIONS/);
  assert.doesNotMatch(output, /SECTION_LANDINGS/);
  assert.equal(readFileSync(legacyRedirectsPath, 'utf8'), before, 'a no-op must not reformat');
});

test('an aborted legacy step leaves the drift maps and the redirect behind, and writes no map', (t) => {
  // The legacy step is last, after the drift maps. Nothing else pins that ordering, so moving it
  // ahead of them would silently cost a move its drift retarget on every abort. This is the
  // regression test for the ordering, not just for the abort.
  const { root, treeComparePath, legacyRedirectsPath, fromRel, toRel } = fixtureRepo({
    legacyDoubleQuoted: true,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const legacyBefore = readFileSync(legacyRedirectsPath, 'utf8');

  let failure;
  try {
    execFileSync('node', [MOVE_DOC, fromRel, toRel], { cwd: root, encoding: 'utf8' });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'move-doc must exit non-zero when the legacy cross-check fails');
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /MANUAL_DESTINATIONS rewrite/);
  assert.match(failure.stderr, /the parsed map names it 2 time\(s\)/);

  assert.equal(readFileSync(legacyRedirectsPath, 'utf8'), legacyBefore, 'nothing written');

  // Everything before it landed: the move, the redirect, and the drift maps.
  assert.ok(existsSync(path.join(root, toRel)), 'the move itself still happened');
  assert.match(
    readFileSync(path.join(root, 'redirects.config.mjs'), 'utf8'),
    /source: '\/docs\/example\/old-name', destination: '\/docs\/example\/new-name'/,
  );
  assert.match(readFileSync(treeComparePath, 'utf8'), /'example\/new-name\.mdx'/);
});

test('an aborted drift step never reaches the legacy step', (t) => {
  // Step 5 refusing must not half-apply step 6 either.
  const { root, legacyRedirectsPath, fromRel, toRel } = fixtureRepo({ doubleQuoted: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const before = readFileSync(legacyRedirectsPath, 'utf8');
  assert.throws(() =>
    execFileSync('node', [MOVE_DOC, fromRel, toRel], { cwd: root, encoding: 'utf8' }),
  );
  assert.equal(readFileSync(legacyRedirectsPath, 'utf8'), before);
});
