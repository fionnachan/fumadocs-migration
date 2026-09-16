import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  LEGACY_REDIRECTS_PATH,
  REDIRECTS_CONFIG_PATH,
  REDIRECTS_END,
  REDIRECTS_START,
  findChainedAutoRedirects,
  pageOf,
  rewriteDestinationMap,
  updateLegacyDestinations,
} from './legacy-destinations.mjs';

const REAL_LEGACY_REDIRECTS = path.join(import.meta.dirname, '..', '..', LEGACY_REDIRECTS_PATH);

/**
 * A fixture module with both maps, in the two shapes Prettier produces (same line, and wrapped onto
 * its own line when the entry is too long), plus a `SECTION_RENAMES` decoy of identical entry shape
 * and an absolute destination.
 *
 * Written already Prettier-clean at the repo's own settings, so the `updateLegacyDestinations` tests
 * below can assert the written file is byte-for-byte the original with one substitution — collateral
 * reformatting would show up as a failure rather than hide in an approximate assertion.
 */
function fixtureSource({ quote = "'" } = {}) {
  const q = quote;
  return (
    `export const SECTION_RENAMES = [[${q}/run-arbitrum-node${q}, ${q}/run-a-node${q}]];\n` +
    `\n` +
    `export const MANUAL_DESTINATIONS = new Map([\n` +
    `  [${q}/get-started/overview${q}, ${q}/docs/get-started${q}],\n` +
    `  [\n` +
    `    ${q}/launch-arbitrum-chain/extend-the-protocol/stf${q},\n` +
    `    ${q}/docs/launch-arbitrum-chain/configuration/core/customize-stf${q},\n` +
    `  ],\n` +
    `  [${q}/arbos${q}, ${q}/docs/how-arbitrum-works/deep-dives/arbos#stylus-specific-differences${q}],\n` +
    `  [${q}/aep${q}, ${q}https://docs.arbitrum.foundation/calculate-aep-fees${q}],\n` +
    `]);\n` +
    `\n` +
    `export const SECTION_LANDINGS = new Map([\n` +
    `  [${q}/how-arbitrum-works/bold/bold-faq${q}, ${q}/docs/how-arbitrum-works/bold${q}],\n` +
    `  [${q}/how-arbitrum-works/bold/other${q}, ${q}/docs/how-arbitrum-works/bold${q}],\n` +
    `]);\n`
  );
}

// --- rewriteDestinationMap -------------------------------------------------------------------------

test('rewrites a same-line MANUAL_DESTINATIONS value, leaves the key alone', () => {
  const { source: next, changed } = rewriteDestinationMap(
    fixtureSource(),
    'MANUAL_DESTINATIONS',
    '/docs/get-started',
    '/docs/welcome',
  );
  assert.equal(changed, 1);
  assert.match(next, /\['\/get-started\/overview', '\/docs\/welcome'\],/);
  assert.doesNotMatch(next, /'\/docs\/get-started'/);
});

test('rewrites a value Prettier wrapped onto its own line', () => {
  // The majority shape in the real file: key and value are both long enough to each get a line.
  const { source: next, changed } = rewriteDestinationMap(
    fixtureSource(),
    'MANUAL_DESTINATIONS',
    '/docs/launch-arbitrum-chain/configuration/core/customize-stf',
    '/docs/launch-arbitrum-chain/configuration/core/stf',
  );
  assert.equal(changed, 1);
  assert.match(next, /\n {4}'\/docs\/launch-arbitrum-chain\/configuration\/core\/stf',\n {2}\],/);
  assert.match(next, /'\/launch-arbitrum-chain\/extend-the-protocol\/stf',/, 'key untouched');
});

test('preserves the `#anchor` a destination carries', () => {
  const { source: next, changed } = rewriteDestinationMap(
    fixtureSource(),
    'MANUAL_DESTINATIONS',
    '/docs/how-arbitrum-works/deep-dives/arbos',
    '/docs/how-arbitrum-works/arbos',
  );
  assert.equal(changed, 1);
  assert.match(next, /'\/docs\/how-arbitrum-works\/arbos#stylus-specific-differences'/);
});

test('never matches a longer page that merely starts with the moved URL', () => {
  // `/docs/how-arbitrum-works/bold` must not swallow `/docs/how-arbitrum-works/bold-faq` or any
  // child page: the closing quote has to land immediately after the URL (or its anchor).
  const source =
    `export const SECTION_LANDINGS = new Map([\n` +
    `  ['/a', '/docs/how-arbitrum-works/bold/gentle-introduction'],\n` +
    `  ['/b', '/docs/how-arbitrum-works/bold-faq'],\n` +
    `]);\n`;
  const { source: next, changed } = rewriteDestinationMap(
    source,
    'SECTION_LANDINGS',
    '/docs/how-arbitrum-works/bold',
    '/docs/bold',
  );
  assert.equal(changed, 0);
  assert.equal(next, source);
});

test('retargets every entry pointing at the moved page, which SECTION_LANDINGS routinely has', () => {
  // Several legacy URLs deliberately share one landing page; a move has to fix all of them.
  const { source: next, changed } = rewriteDestinationMap(
    fixtureSource(),
    'SECTION_LANDINGS',
    '/docs/how-arbitrum-works/bold',
    '/docs/bold',
  );
  assert.equal(changed, 2);
  assert.equal((next.match(/'\/docs\/bold'/g) ?? []).length, 2);
  assert.doesNotMatch(next, /'\/docs\/how-arbitrum-works\/bold'/);
});

test('never rewrites a quoted string used as a key, only values', () => {
  // Pathological today (no legacy key starts with `/docs`), but it is the property the value test
  // exists to hold: only the string the `]` follows is a destination.
  const source =
    `export const MANUAL_DESTINATIONS = new Map([\n` +
    `  ['/docs/moved', '/docs/elsewhere'],\n` +
    `  ['/legacy', '/docs/other'],\n` +
    `]);\n`;
  const { source: next, changed } = rewriteDestinationMap(
    source,
    'MANUAL_DESTINATIONS',
    '/docs/moved',
    '/docs/moved-new',
  );
  assert.equal(changed, 0, 'the moved URL appears only as a key here');
  assert.equal(next, source);
});

test('never rewrites a URL quoted inside a `//` comment', () => {
  // Most entries carry a comment recording the upstream title and why the entry exists. Rewriting
  // one turns a record into a false statement, and inflates the count the cross-check compares.
  const source =
    `export const MANUAL_DESTINATIONS = new Map([\n` +
    `  // The basename fallback sent this to '/docs/stylus/gas-optimization' instead.\n` +
    `  ['/chain/costs/gas-optimization', '/docs/stylus/gas-optimization'],\n` +
    `]);\n`;
  const { source: next, changed } = rewriteDestinationMap(
    source,
    'MANUAL_DESTINATIONS',
    '/docs/stylus/gas-optimization',
    '/docs/stylus/best-practices/gas-optimization',
  );
  assert.equal(changed, 1, 'only the value counts, not the mention in the comment');
  assert.match(next, /\/\/ The basename fallback sent this to '\/docs\/stylus\/gas-optimization'/);
  assert.match(next, /'\/docs\/stylus\/best-practices\/gas-optimization'\],/);
});

test('rewrites the value of an entry whose key contains a `//`, on one line', () => {
  // `MANUAL_DESTINATIONS` records upstream's malformed sources verbatim, so a key can hold a
  // doubled leading slash or a stray-slash absolute URL. Reading that as a comment marker made the
  // entry's own value look commented out: the rewrite reported no change and the cross-check
  // aborted the move blaming a reformat that never happened. The two live entries escape it only
  // because Prettier wraps them; a shorter one sits on one line, which is this shape.
  const source =
    `export const MANUAL_DESTINATIONS = new Map([\n` +
    `  ['//aep/fees', '/docs/costs/aep'],\n` +
    `  ['/https://docs.arbitrum.foundation/aep', '/docs/costs/aep'],\n` +
    `]);\n`;
  const { source: next, changed } = rewriteDestinationMap(
    source,
    'MANUAL_DESTINATIONS',
    '/docs/costs/aep',
    '/docs/launch-arbitrum-chain/costs/aep',
  );
  assert.equal(changed, 2);
  assert.doesNotMatch(next, /'\/docs\/costs\/aep'/);
  assert.match(next, /\['\/\/aep\/fees', '\/docs\/launch-arbitrum-chain\/costs\/aep'\],/);
  assert.match(next, /\['\/https:\/\/docs\.arbitrum\.foundation\/aep',/, 'key untouched');
});

test('still skips a value inside a commented-out entry', () => {
  // The case the guard exists for: a whole entry commented out still reads as `'…'],`, so without
  // the guard it would be rewritten, inflating the count the cross-check compares and aborting an
  // otherwise fine move.
  const source =
    `export const MANUAL_DESTINATIONS = new Map([\n` +
    `  // ['/retired', '/docs/costs/aep'],\n` +
    `  ['/aep/fees', '/docs/costs/aep'],\n` +
    `]);\n`;
  const { source: next, changed } = rewriteDestinationMap(
    source,
    'MANUAL_DESTINATIONS',
    '/docs/costs/aep',
    '/docs/launch-arbitrum-chain/costs/aep',
  );
  assert.equal(changed, 1, 'only the live entry counts');
  assert.match(next, /\/\/ \['\/retired', '\/docs\/costs\/aep'\],/, 'commented entry untouched');
  assert.match(next, /\['\/aep\/fees', '\/docs\/launch-arbitrum-chain\/costs\/aep'\],/);
});

test('only touches the named map, never the other one', () => {
  // Both maps hold `/docs/...` values in identical syntax, so the range is the only thing keeping a
  // SECTION_LANDINGS retarget out of MANUAL_DESTINATIONS and vice versa.
  const source =
    `export const MANUAL_DESTINATIONS = new Map([\n  ['/a', '/docs/shared'],\n]);\n` +
    `\nexport const SECTION_LANDINGS = new Map([\n  ['/b', '/docs/shared'],\n]);\n`;
  const manual = rewriteDestinationMap(source, 'MANUAL_DESTINATIONS', '/docs/shared', '/docs/new');
  assert.equal(manual.changed, 1);
  assert.match(manual.source, /MANUAL_DESTINATIONS = new Map\(\[\n {2}\['\/a', '\/docs\/new'\],/);
  assert.match(manual.source, /SECTION_LANDINGS = new Map\(\[\n {2}\['\/b', '\/docs\/shared'\],/);

  const landings = rewriteDestinationMap(source, 'SECTION_LANDINGS', '/docs/shared', '/docs/new');
  assert.equal(landings.changed, 1);
  assert.match(
    landings.source,
    /MANUAL_DESTINATIONS = new Map\(\[\n {2}\['\/a', '\/docs\/shared'\],/,
  );
});

test('reports zero changes and returns the source unchanged when the map is absent', () => {
  const source = `export const SOMETHING_ELSE = new Map([['/a', '/docs/b']]);\n`;
  const { source: next, changed } = rewriteDestinationMap(
    source,
    'MANUAL_DESTINATIONS',
    '/docs/b',
    '/docs/c',
  );
  assert.equal(changed, 0);
  assert.equal(next, source);
});

test('pageOf drops the anchor', () => {
  assert.equal(pageOf('/docs/a/b#frag'), '/docs/a/b');
  assert.equal(pageOf('/docs/a/b'), '/docs/a/b');
});

// --- the rewrite stays inside the two maps, against the real file ----------------------------------

test('never touches SECTION_RENAMES or any other string in the real legacy-redirects.mjs', () => {
  // SECTION_RENAMES has the same `['from', 'to']` entry shape. Its values are bare section prefixes
  // (`/run-a-node`, `/get-started`), so they can never equal a `/docs/...` page URL — but the range
  // check, not that coincidence, is what has to hold, so move pages whose URLs spell those prefixes.
  const real = readFileSync(REAL_LEGACY_REDIRECTS, 'utf8');
  for (const url of ['/run-a-node', '/get-started', '/build-decentralized-apps', '/docs']) {
    for (const name of ['MANUAL_DESTINATIONS', 'SECTION_LANDINGS']) {
      const { source: next, changed } = rewriteDestinationMap(real, name, url, '/docs/moved');
      assert.equal(changed, 0, `moving ${url} must not touch ${name} in the real file`);
      assert.equal(next, real);
    }
  }
});

test('the textual rewrite matches the parsed maps for every real destination', async () => {
  // The whole-file version of the cross-check: for each distinct page the shipped maps name, the
  // regex must find exactly as many values as the parsed map holds. A reformat of the real file
  // that made the rewrite miss would fail here, not silently in a later move.
  const real = readFileSync(REAL_LEGACY_REDIRECTS, 'utf8');
  const mod = await import(pathToFileURL(REAL_LEGACY_REDIRECTS).href);
  for (const name of ['MANUAL_DESTINATIONS', 'SECTION_LANDINGS']) {
    const counts = new Map();
    for (const destination of mod[name].values()) {
      const page = pageOf(destination);
      if (!page.startsWith('/docs/')) continue; // absolute destinations are not pages here
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
    assert.ok(counts.size > 0, `${name} should name at least one page`);
    for (const [page, expected] of counts) {
      const { changed } = rewriteDestinationMap(real, name, page, '/docs/x/y');
      assert.equal(changed, expected, `${name}: '${page}'`);
    }
  }
});

// --- updateLegacyDestinations (file I/O) -----------------------------------------------------------

/**
 * A `redirects.config.mjs` holding `entries` inside the `AUTO-GENERATED` markers, in either shape
 * the real file contains: `wrapped` is what Prettier produces once an entry outgrows the print
 * width (every committed entry today), and the flat form is what `appendRedirect` writes. One entry
 * is placed *outside* the block, below the end marker, standing in for the legacy spread and any
 * hand-written redirect: those are not `move-doc`'s to retarget and must never be named.
 */
function redirectsConfigSource(entries, { wrapped = true, outside = [] } = {}) {
  const flat = ([source, destination]) =>
    `  { source: '${source}', destination: '${destination}', permanent: true },`;
  const wrap = ([source, destination]) =>
    `  {\n    source: '${source}',\n    destination: '${destination}',\n    permanent: true,\n  },`;
  const render = (list) => list.map(wrapped ? wrap : flat).join('\n');
  return (
    `export const redirects = [\n` +
    `  ${REDIRECTS_START}\n` +
    `${render(entries)}\n` +
    `  ${REDIRECTS_END}\n` +
    `${outside.length ? render(outside) + '\n' : ''}` +
    `];\n`
  );
}

/** A throwaway repo holding just `scripts/lib/legacy-redirects.mjs` and a Prettier config. */
function fixtureRepo(t, { quote = "'", redirects = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-destinations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const abs = path.join(root, LEGACY_REDIRECTS_PATH);
  mkdirSync(path.dirname(abs), { recursive: true });
  // Prettier resolves config from the file's own location; give the fixture one matching the real
  // repo's style, so the write-through-Prettier step runs the way it actually runs.
  writeFileSync(
    path.join(root, '.prettierrc.json'),
    '{"singleQuote": true, "trailingComma": "all", "printWidth": 100}',
  );
  writeFileSync(abs, fixtureSource({ quote }));
  const redirectsAbs = path.join(root, REDIRECTS_CONFIG_PATH);
  if (redirects !== null) writeFileSync(redirectsAbs, redirects);
  return { root, abs, redirectsAbs };
}

test('updateLegacyDestinations writes the file and reports one note per map that changed', async (t) => {
  const { root, abs } = fixtureRepo(t);
  const before = readFileSync(abs, 'utf8');
  const notes = await updateLegacyDestinations(root, '/docs/get-started', '/docs/welcome', false);

  assert.equal(notes.length, 2, JSON.stringify(notes));
  assert.match(notes[0], /legacy-redirects\.mjs: retargeted 1 MANUAL_DESTINATIONS destination/);
  assert.match(notes[1], /NOTE: redirects\.legacy\.mjs/);
  assert.match(notes[1], /pnpm redirects:legacy/);
  // The note has to name the gate it puts red, not just the extra hop: `redirects:check` follows
  // one hop, so the orphaned legacy sources report DEAD until the legacy map is regenerated.
  assert.match(notes[1], /pnpm redirects:check/);
  assert.match(notes[1], /DEAD/);
  // ...and it must not also claim an earlier move's redirect chained onto this page. This fixture
  // has no `redirects.config.mjs` at all, so there is no such entry, and asserting one anyway sent
  // the mover hunting for a line that is not there on 64 of the 68 pages the two maps name.
  assert.doesNotMatch(notes[1], /redirects\.config\.mjs/);
  assert.doesNotMatch(notes[1], /AUTO-GENERATED/);

  // Byte-for-byte the original with exactly one substitution: SECTION_RENAMES, the absolute
  // destination, and the Prettier layout of every other entry all survive untouched.
  assert.equal(
    readFileSync(abs, 'utf8'),
    before.replace("'/docs/get-started'", "'/docs/welcome'"),
    'only the one destination changed',
  );
});

test('updateLegacyDestinations retargets both maps in one pass', async (t) => {
  const { root, abs } = fixtureRepo(t);
  // Point a MANUAL_DESTINATIONS entry at the same page SECTION_LANDINGS lands on, so one move has
  // to fix both maps — the case a per-map early return would get wrong.
  writeFileSync(
    abs,
    readFileSync(abs, 'utf8').replace("'/docs/get-started'", "'/docs/how-arbitrum-works/bold'"),
  );

  const notes = await updateLegacyDestinations(
    root,
    '/docs/how-arbitrum-works/bold',
    '/docs/bold',
    false,
  );
  assert.equal(notes.length, 3, JSON.stringify(notes));
  assert.match(notes[0], /retargeted 1 MANUAL_DESTINATIONS destination/);
  assert.match(notes[1], /retargeted 2 SECTION_LANDINGS destination/);

  const next = readFileSync(abs, 'utf8');
  assert.doesNotMatch(next, /'\/docs\/how-arbitrum-works\/bold'/);
  assert.equal((next.match(/'\/docs\/bold'/g) ?? []).length, 3);
});

test('updateLegacyDestinations in dry-run mode reports the same notes but writes nothing', async (t) => {
  const { root, abs } = fixtureRepo(t);
  const before = readFileSync(abs, 'utf8');

  const notes = await updateLegacyDestinations(root, '/docs/get-started', '/docs/welcome', true);
  assert.equal(notes.length, 2, JSON.stringify(notes));
  assert.match(notes[0], /retargeted 1 MANUAL_DESTINATIONS destination/);
  assert.equal(readFileSync(abs, 'utf8'), before, 'dry-run must not write');
});

test('updateLegacyDestinations reports nothing and writes nothing when no map names the page', async (t) => {
  const { root, abs } = fixtureRepo(t);
  const before = readFileSync(abs, 'utf8');

  const notes = await updateLegacyDestinations(root, '/docs/unrelated', '/docs/unrelated-2', false);
  assert.deepEqual(notes, []);
  assert.equal(readFileSync(abs, 'utf8'), before, 'a no-op must not reformat the file');
});

test('updateLegacyDestinations is a no-op when the file is absent', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-destinations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notes = await updateLegacyDestinations(root, '/docs/a', '/docs/b', false);
  assert.deepEqual(notes, []);
});

test('updateLegacyDestinations is a no-op for a partial (no URL) or a URL-preserving move', async (t) => {
  const { root, abs } = fixtureRepo(t);
  const before = readFileSync(abs, 'utf8');
  assert.deepEqual(await updateLegacyDestinations(root, null, '/docs/b', false), []);
  assert.deepEqual(await updateLegacyDestinations(root, '/docs/a', null, false), []);
  assert.deepEqual(await updateLegacyDestinations(root, '/docs/a', '/docs/a', false), []);
  assert.equal(readFileSync(abs, 'utf8'), before);
});

// --- the chained AUTO-GENERATED redirect note ------------------------------------------------------

test('findChainedAutoRedirects names only the AUTO-GENERATED entries pointing at the moved page', (t) => {
  const { root } = fixtureRepo(t, {
    redirects: redirectsConfigSource(
      [
        ['/docs/old/batch-poster', '/docs/run-a-node/run-batch-poster'],
        ['/docs/old/node', '/docs/run-a-node'],
        ['/docs/old/other', '/docs/somewhere-else'],
      ],
      { outside: [['/docs/legacy/node', '/docs/run-a-node']] },
    ),
  });

  assert.deepEqual(findChainedAutoRedirects(root, '/docs/run-a-node/run-batch-poster'), [
    '/docs/old/batch-poster',
  ]);
  // The closing quote is not what does the work here: the comparison is exact, so the entry
  // pointing at the child page cannot be claimed by a move of the parent.
  assert.deepEqual(findChainedAutoRedirects(root, '/docs/run-a-node'), ['/docs/old/node']);
  assert.deepEqual(findChainedAutoRedirects(root, '/docs/run-a-nod'), []);
  assert.deepEqual(findChainedAutoRedirects(root, '/docs/never-moved'), []);
});

test('findChainedAutoRedirects reads the flat shape move-doc writes as well as the wrapped one', (t) => {
  const entries = [['/docs/old/node', '/docs/run-a-node']];
  const wrapped = fixtureRepo(t, { redirects: redirectsConfigSource(entries) });
  const flat = fixtureRepo(t, { redirects: redirectsConfigSource(entries, { wrapped: false }) });

  assert.deepEqual(findChainedAutoRedirects(wrapped.root, '/docs/run-a-node'), ['/docs/old/node']);
  assert.deepEqual(findChainedAutoRedirects(flat.root, '/docs/run-a-node'), ['/docs/old/node']);
});

test('findChainedAutoRedirects is empty when the file is absent or the markers are gone', (t) => {
  const none = fixtureRepo(t);
  assert.deepEqual(findChainedAutoRedirects(none.root, '/docs/run-a-node'), []);

  const unmarked = fixtureRepo(t, {
    redirects:
      "export const redirects = [\n  { source: '/a', destination: '/docs/run-a-node' },\n];\n",
  });
  assert.deepEqual(findChainedAutoRedirects(unmarked.root, '/docs/run-a-node'), []);
});

test('updateLegacyDestinations adds a second note naming the chained AUTO-GENERATED sources', async (t) => {
  const { root } = fixtureRepo(t, {
    redirects: redirectsConfigSource([
      ['/docs/old/get-started', '/docs/get-started'],
      ['/docs/older/get-started', '/docs/get-started'],
      ['/docs/old/other', '/docs/somewhere-else'],
    ]),
  });

  const notes = await updateLegacyDestinations(root, '/docs/get-started', '/docs/welcome', false);

  assert.equal(notes.length, 3, JSON.stringify(notes));
  assert.match(notes[0], /retargeted 1 MANUAL_DESTINATIONS destination/);
  assert.match(notes[1], /NOTE: redirects\.legacy\.mjs/);
  // Naming the sources is the point: "there is a chained entry" without saying which one leaves
  // the mover grepping a file whose other entries look identical.
  assert.match(notes[2], /AUTO-GENERATED block in redirects\.config\.mjs has 2 redirect\(s\)/);
  assert.match(notes[2], /'\/docs\/old\/get-started', '\/docs\/older\/get-started'/);
  assert.doesNotMatch(notes[2], /somewhere-else/);
  assert.match(notes[2], /DEAD/);
  assert.match(notes[2], /retarget them to '\/docs\/welcome'/);
});

test('the chained note is not gated on either legacy map having changed', async (t) => {
  // A page no legacy map names, moved twice. The first move left an AUTO-GENERATED entry pointing
  // at it; this move chains that entry. Nothing else reports it, so the note has to survive the
  // "no map changed" early return.
  const { root, abs } = fixtureRepo(t, {
    redirects: redirectsConfigSource([['/docs/old/unrelated', '/docs/unrelated']]),
  });
  const before = readFileSync(abs, 'utf8');

  const notes = await updateLegacyDestinations(root, '/docs/unrelated', '/docs/unrelated-2', false);

  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.match(notes[0], /AUTO-GENERATED block in redirects\.config\.mjs has 1 redirect\(s\)/);
  assert.match(notes[0], /'\/docs\/old\/unrelated'/);
  assert.doesNotMatch(notes[0], /redirects\.legacy\.mjs still sends/);
  assert.equal(readFileSync(abs, 'utf8'), before, 'a map no-op must still not reformat the file');
});

test('a dry run reports the chained note without writing anything', async (t) => {
  const { root, abs } = fixtureRepo(t, {
    redirects: redirectsConfigSource([['/docs/old/get-started', '/docs/get-started']]),
  });
  const before = readFileSync(abs, 'utf8');

  const notes = await updateLegacyDestinations(root, '/docs/get-started', '/docs/welcome', true);

  assert.equal(notes.length, 3, JSON.stringify(notes));
  assert.match(notes[2], /AUTO-GENERATED block/);
  assert.equal(readFileSync(abs, 'utf8'), before, 'dry-run must not write');
});

// --- a missed textual match is loud, not silent ----------------------------------------------------

test('updateLegacyDestinations throws when a double-quoted reformat makes the rewrite miss', async (t) => {
  // Still a valid module naming the moved page, but invisible to the single-quote regex. Without
  // the cross-check this reported "no entry" and left a legacy URL pointing at a 404.
  const { root, abs } = fixtureRepo(t, { quote: '"' });
  const before = readFileSync(abs, 'utf8');

  await assert.rejects(
    () => updateLegacyDestinations(root, '/docs/get-started', '/docs/welcome', false),
    (err) => {
      assert.match(
        err.message,
        /MANUAL_DESTINATIONS rewrite of '\/docs\/get-started' -> '\/docs\/welcome' changed 0 value\(s\) but the parsed map names it 1 time\(s\)/,
      );
      assert.match(err.message, /Nothing was written/);
      return true;
    },
  );
  assert.equal(readFileSync(abs, 'utf8'), before, 'nothing written on abort');
});

test('the cross-check fires for SECTION_LANDINGS too, not just MANUAL_DESTINATIONS', async (t) => {
  const { root, abs } = fixtureRepo(t);
  // Reformat only the SECTION_LANDINGS literal to double quotes: MANUAL_DESTINATIONS still matches,
  // so a per-map check that stopped at the first map would pass this and lose the landings.
  const source = readFileSync(abs, 'utf8');
  const start = source.indexOf('export const SECTION_LANDINGS');
  writeFileSync(abs, source.slice(0, start) + source.slice(start).replaceAll("'", '"'));

  await assert.rejects(
    () => updateLegacyDestinations(root, '/docs/how-arbitrum-works/bold', '/docs/bold', false),
    (err) => {
      assert.match(err.message, /SECTION_LANDINGS rewrite/);
      assert.match(err.message, /names it 2 time\(s\)/);
      return true;
    },
  );
});
