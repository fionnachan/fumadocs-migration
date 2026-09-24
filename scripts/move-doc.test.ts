/**
 * End-to-end tests for `move-doc.ts` against a throwaway fixture "repo" — not a unit test of any one
 * function, but a check that running the real CLI actually rewrites the files on disk the way the
 * inline doc comment promises. Focused on FS-2697's `MANUAL_DESTINATIONS` / `SECTION_LANDINGS`
 * retarget, which only shows up end-to-end because `move-doc.ts`'s `main()` resolves every path off
 * `process.cwd()`, and whose ordering (it can refuse, so it must run after everything that must not
 * be lost) is a property only a full run can pin. A sibling set covering the drift exemption maps
 * was deleted with the upstream comparison (FS-2706).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readVars } from '../lib/var-links.ts';

const MOVE_DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'move-doc.ts');

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

/** A throwaway repo with just enough shape for move-doc.ts to run: a docs tree and a
 * legacy-redirects module whose `MANUAL_DESTINATIONS` and `SECTION_LANDINGS` both point at the page
 * under test.
 *
 * `legacyDoubleQuoted` writes the same maps with double quotes, invisible to the single-quote-only
 * textual rewrite, so the cross-check aborts that step. That is the only way to reach the failure
 * path end to end.
 */
function fixtureRepo({ legacyDoubleQuoted = false }: { legacyDoubleQuoted?: boolean } = {}): {
  root: string;
  legacyRedirectsPath: string;
  fromRel: string;
  toRel: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'move-doc-e2e-'));
  // move-doc.ts writes legacy-redirects.ts back through Prettier, which resolves config from the
  // file's own location. Give the fixture its own, matching the real repo's style, so the assertions
  // below exercise the actual write path instead of Prettier's double-quote default.
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

  // The legacy-redirect overlay: hand-written legacy URL -> this site's page, stored as site URLs
  // rather than file paths. Nothing here reads an upstream checkout, which is the whole point —
  // `move-doc` retargets these maps from the two exports alone.
  const lq = legacyDoubleQuoted ? '"' : "'";
  writeFileSync(
    path.join(libDir, 'legacy-redirects.ts'),
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
    legacyRedirectsPath: path.join(libDir, 'legacy-redirects.ts'),
    fromRel: 'content/docs/example/old-name.mdx',
    toRel: 'content/docs/example/new-name.mdx',
  };
}

/** What `execFileSync` throws on a non-zero exit with `encoding: 'utf8'`. */
function isExecError(value: unknown): value is Error & { status: number | null; stderr: string } {
  return (
    value instanceof Error &&
    'status' in value &&
    (typeof value.status === 'number' || value.status === null) &&
    'stderr' in value &&
    typeof value.stderr === 'string'
  );
}

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

  assert.match(output, /legacy-redirects\.ts: retargeted 2 MANUAL_DESTINATIONS destination\(s\)/);
  assert.match(output, /legacy-redirects\.ts: retargeted 1 SECTION_LANDINGS destination\(s\)/);
  assert.match(
    output,
    /hand-maintained/,
    'tells the mover the committed legacy map is a hop stale and is theirs to fix',
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
  assert.match(output, /legacy-redirects\.ts: retargeted 2 MANUAL_DESTINATIONS destination\(s\)/);
  assert.match(output, /legacy-redirects\.ts: retargeted 1 SECTION_LANDINGS destination\(s\)/);
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

test('an aborted legacy step leaves the move and the redirect behind, and writes no map', (t) => {
  // The legacy step is last, because it is the one step that can refuse. Nothing else pins that
  // ordering, so moving it ahead of the redirect would silently cost a page its redirect on every
  // abort. This is the regression test for the ordering, not just for the abort.
  const { root, legacyRedirectsPath, fromRel, toRel } = fixtureRepo({
    legacyDoubleQuoted: true,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const legacyBefore = readFileSync(legacyRedirectsPath, 'utf8');

  let failure: unknown;
  try {
    execFileSync('node', [MOVE_DOC, fromRel, toRel], { cwd: root, encoding: 'utf8' });
  } catch (err) {
    failure = err;
  }
  assert.ok(isExecError(failure), 'move-doc must exit non-zero when the legacy cross-check fails');
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /MANUAL_DESTINATIONS rewrite/);
  assert.match(failure.stderr, /the parsed map names it 2 time\(s\)/);

  assert.equal(readFileSync(legacyRedirectsPath, 'utf8'), legacyBefore, 'nothing written');

  // Everything before it landed: the move and the redirect.
  assert.ok(existsSync(path.join(root, toRel)), 'the move itself still happened');
  assert.match(
    readFileSync(path.join(root, 'redirects.config.ts'), 'utf8'),
    /source: '\/docs\/example\/old-name', destination: '\/docs\/example\/new-name'/,
  );
});

// --- FS-2725: `{var:name}` placeholder links --------------------------------------------------------

test('move-doc warns about a placeholder link to the moved page and never rewrites one', (t) => {
  const { root } = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // `readVars()` reads the real repo's vars.json, so the fixture borrows a real key whose value is a
  // path segment and derives every path from it, the way the check-links fixture does, so a change
  // to the value cannot break this test in a way that points nowhere.
  const segment = String(readVars().nitroRepositorySlug);
  const fromDir = path.join(root, 'content', 'docs', segment);
  mkdirSync(fromDir, { recursive: true });
  mkdirSync(path.join(root, 'content', 'docs', 'other'), { recursive: true });

  // Outbound: the moved page carries its own relative links, one through a placeholder and one
  // plain, both to a sibling that stays behind. Only the plain one may be re-based after the move.
  const outboundPlaceholder = `[Sibling](./{var:nitroRepositorySlug}-sibling.mdx)`;
  writeFileSync(path.join(fromDir, `${segment}-sibling.mdx`), PAGE_FRONTMATTER);
  writeFileSync(
    path.join(fromDir, 'old-name.mdx'),
    PAGE_FRONTMATTER +
      `${outboundPlaceholder}\n\nAnd plainly: [Sibling](./${segment}-sibling.mdx)\n`,
  );

  // Inbound: another page links to the moved page, once through a placeholder and once plainly.
  const linkerAbs = path.join(root, 'content', 'docs', 'example', 'linker.mdx');
  const inboundPlaceholder = '[Old](/docs/{var:nitroRepositorySlug}/old-name)';
  writeFileSync(
    linkerAbs,
    PAGE_FRONTMATTER.replace('Old name', 'Linker') +
      `${inboundPlaceholder}\n\nAnd plainly: [Old](/docs/${segment}/old-name)\n`,
  );

  const toRel = 'content/docs/other/new-name.mdx';
  const run = spawnSync('node', [MOVE_DOC, `content/docs/${segment}/old-name.mdx`, toRel], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);

  // Inbound: the placeholder resolves to the moved page, so it is reported with the other links that
  // cannot be auto-rewritten, under the form the writer typed rather than an "(expression)" fallback.
  assert.match(run.stderr, /1 reference\(s\) resolve to the move but can't be auto-rewritten/);
  assert.match(run.stderr, /linker\.mdx: \/docs\/\{var:nitroRepositorySlug\}\/old-name/);
  const linker = readFileSync(linkerAbs, 'utf8');
  assert.ok(
    linker.includes(inboundPlaceholder),
    'inbound placeholder link left exactly as written',
  );
  assert.ok(linker.includes('[Old](/docs/other/new-name)'), 'plain inbound link rewritten');
  assert.ok(
    !linker.includes(`/docs/${segment}/old-name)`),
    'no plain link still names the old page',
  );

  // Outbound: re-basing the placeholder link would write the variable's current value into the file.
  const moved = readFileSync(path.join(root, toRel), 'utf8');
  assert.ok(
    moved.includes(outboundPlaceholder),
    'outbound placeholder link left exactly as written',
  );
  assert.ok(
    moved.includes(`[Sibling](../${segment}/${segment}-sibling.mdx)`),
    'plain outbound link re-based from the new directory',
  );
});
