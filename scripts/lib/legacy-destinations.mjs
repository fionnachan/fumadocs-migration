/**
 * legacy-destinations — keep `scripts/lib/legacy-redirects.mjs`'s `MANUAL_DESTINATIONS` and
 * `SECTION_LANDINGS` in sync with `move-doc`.
 *
 * Both maps are hand-written overlays from a legacy docs.arbitrum.io URL to a page on this site.
 * Their *values* are site URLs (`/docs/...`, optionally with an `#anchor`) that `move-doc` otherwise
 * has no idea exist, so moving one of those pages leaves a legacy URL pointing at a 404.
 * `scripts/generate-legacy-redirects.test.mjs` catches it ("every hand-written destination still
 * names a live page in the content tree"), but only in whatever PR happens to run `pnpm test` next,
 * which is rarely the move itself, so it fails Gates in an unrelated PR. This module makes `move-doc`
 * fix it in the same commit as the move. Sibling of `scripts/lib/drift-maps.mjs`, deliberately the
 * same shape.
 *
 * **This module outlived the legacy redirect *generator*, as designed.** The generator half (the
 * code that read a sibling arbitrum-docs checkout to derive upstream's URL corpus) was deleted in
 * FS-2706 when that repo was archived. The two maps were not: docs.arbitrum.io URLs have to keep
 * resolving forever, so the hand-maintained overlay is permanent. This module reads nothing but the
 * two named exports and `redirects.config.mjs` (read-only, and itself permanent), and rewrites
 * nothing but the two object literals that declare those exports, which is why the generator's
 * deletion cost it no change at all.
 *
 * Map *keys* are legacy root-level URLs and are never touched: only this site's pages move. Every
 * property `drift-maps` holds, this holds too, for the same reasons:
 *
 *  - **It only ever edits inside the named `new Map([...])` literal**, so a URL that also appears in
 *    `SECTION_RENAMES`, in a doc comment, or in an unrelated declaration is out of reach.
 *  - **Only values are rewritten, never keys.** Inside a `Map` entry the value is the string that
 *    closes the `[key, value]` pair, so a quoted string is a value exactly when the next
 *    non-whitespace after it (past an optional trailing comma) is `]`. A key is followed by another
 *    string. That is enough to tell them apart without parsing the module as an AST.
 *  - **A missed match is loud.** The rewrite is textual and single-quote-only, so a reformat to
 *    double quotes, or an entry written as a template literal, would match nothing and leave the
 *    stale destination in place, reintroducing exactly the bug this module fixes with no warning.
 *    `assertLegacyDestinationsRewrite` imports the module and checks the textual change count
 *    against the real parsed maps, so a miss throws instead of passing silently.
 *  - **Nothing is written until every rewrite, and its Prettier pass, has succeeded.**
 *
 * What this module does *not* do is retarget `redirects.legacy.mjs` itself, the committed map of
 * 4,424 legacy URLs. Readers do not need it: `move-doc` appends `oldUrl -> newUrl` to
 * `redirects.config.mjs`, and Next serves one redirect per request, so a legacy URL still reaches the
 * moved page in two hops. `pnpm redirects:check` does care. It compares a destination against
 * the routable pages and never follows a second hop, so every legacy source still naming the moved
 * page reports DEAD. The note printed on the CLI says so, and says the file is hand-maintained, so
 * the fix is to retarget those entries or accept the extra hop.
 *
 * The same one-hop reading reaches `redirects.config.mjs`'s own `AUTO-GENERATED` block, where an
 * earlier move's redirect whose destination is the page now being moved becomes a two-hop chain that
 * regenerating cannot fix. That is a **second, conditional note**: `findChainedAutoRedirects` looks
 * for such an entry and names its source URL(s), so the CLI asserts a chain only when one exists.
 * Saying it unconditionally was false for 64 of the 68 pages the two maps name. It is also
 * deliberately not gated on either map having changed, because a chained entry has nothing to do
 * with the legacy maps and there is no other signal when they are silent.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';

export const LEGACY_REDIRECTS_PATH = path.join('scripts', 'lib', 'legacy-redirects.mjs');

/**
 * The redirect file `move-doc` appends a moved page's own redirect to, and the two markers bounding
 * the block it maintains there. Declared here rather than in `move-doc.mjs` so the appender and the
 * chained-entry reader below share one definition: `move-doc.mjs` imports these, and it cannot
 * export them back, because importing it runs its `main()`.
 */
export const REDIRECTS_CONFIG_PATH = 'redirects.config.mjs';
export const REDIRECTS_START = '// AUTO-GENERATED REDIRECTS START';
export const REDIRECTS_END = '// AUTO-GENERATED REDIRECTS END';

/** The maps this module maintains, in the order their notes are reported. */
export const DESTINATION_MAPS = ['MANUAL_DESTINATIONS', 'SECTION_LANDINGS'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The page part of a destination, dropping any `#anchor` (mirrors the generator and its test). */
export function pageOf(destination) {
  return destination.split('#')[0];
}

/**
 * The `[start, end)` offsets of the body of the `new Map([...])` literal declared as `name` in
 * `source`, or `null` when the declaration is not found in the shape this module knows how to edit.
 *
 * Confining the rewrite to this range is what keeps `SECTION_RENAMES` — whose values are bare
 * section prefixes, and whose entries have the same `['from', 'to']` shape — and every other string
 * in the file out of reach. Finding nothing here is not an error on its own: it means zero textual
 * changes, which `assertLegacyDestinationsRewrite` then compares against the parsed map and rejects
 * if the map really did name the moved page.
 */
function mapRange(source, name) {
  const start = new RegExp(`^export const ${name} = new Map\\(\\[$`, 'm').exec(source);
  if (!start) return null;
  const from = start.index + start[0].length;
  const end = source.indexOf('\n]);', from);
  return end === -1 ? null : [from, end];
}

/**
 * Rewrite every value in the `name` map in `source` that names the page `oldUrl` so it names
 * `newUrl` instead, preserving any `#anchor` the entry carries. Only that one map literal is
 * touched, and within it only values.
 *
 * `(?=\s*,?\s*\])` is the value test: the last string of a `[key, value]` pair is the one the `]`
 * follows. Both formattings Prettier produces are covered — the one-line `['a', 'b'],` and the
 * wrapped form where the value sits on its own line with a trailing comma.
 *
 * The `'` immediately after the optional anchor group is what stops `/docs/get-started` from
 * matching inside `/docs/get-started/child`: the quote has to close right there.
 *
 * A match inside a `//` comment is skipped. Most entries in both maps carry a comment recording the
 * upstream frontmatter title and why the entry exists; rewriting one turns a record of what happened
 * into a false statement, and it also inflates `changed`, which then trips
 * `assertLegacyDestinationsRewrite` into blaming a reformat and aborting an otherwise fine move.
 *
 * @returns {{ source: string, changed: number }}
 */
export function rewriteDestinationMap(source, name, oldUrl, newUrl) {
  const range = mapRange(source, name);
  if (!range) return { source, changed: 0 };
  const [from, to] = range;
  let changed = 0;
  const re = new RegExp(`'${escapeRegExp(oldUrl)}(#[^']*)?'(?=\\s*,?\\s*\\])`, 'g');
  const original = source.slice(from, to);
  const body = original.replace(re, (match, anchor, offset) => {
    if (inLineComment(original, offset)) return match;
    changed++;
    return `'${newUrl}${anchor ?? ''}'`;
  });
  return { source: changed ? source.slice(0, from) + body + source.slice(to) : source, changed };
}

/**
 * Whether `offset` in `body` sits after a `//` that opens a line comment, i.e. one outside a string
 * literal.
 *
 * The `//` has to be found by scanning, not by a plain `includes`, because a legacy *key* can
 * contain one. `MANUAL_DESTINATIONS` records upstream's malformed sources verbatim, and two of them
 * carry a `//`: a doubled leading slash (`'//launch-arbitrum-chain/…'`) and an absolute URL written
 * with a stray leading slash (`'/https://docs.arbitrum.foundation/…'`). Read as a comment marker, a
 * key like that makes the entry's own value look commented out, the rewrite reports no change, and
 * the cross-check then aborts the move blaming a reformat that never happened. Both live entries
 * are long enough that Prettier wraps the value onto its own line, which is the only reason the
 * plain scan worked; a shorter one would sit on one line and break it.
 *
 * Only single-quoted strings are tracked, matching the rewrite itself: a double-quoted reformat
 * makes the rewrite match nothing, which `assertLegacyDestinationsRewrite` turns into a loud abort
 * rather than a silent miss.
 */
function inLineComment(body, offset) {
  const lineStart = body.lastIndexOf('\n', offset) + 1;
  let inString = false;
  for (let i = lineStart; i < offset; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
    } else if (ch === '/' && body[i + 1] === '/') {
      return true;
    }
  }
  return false;
}

/**
 * Cross-check the textual rewrite against the module's own parsed maps.
 *
 * Imports `legacyRedirectsPath` (an ordinary side-effect-free ESM module) and counts, structurally,
 * how many entries in each map point at the page `oldUrl`. If a count does not equal the number of
 * textual substitutions in that map, the regex missed an entry it should have hit, or hit one it
 * should not have, and the whole move is aborted rather than left with a half-retargeted map.
 *
 * This import is the module's only coupling to `legacy-redirects.mjs` beyond the two literals, and
 * it is deliberately by export name: should the maps ever move to another file, the rewrite finds
 * nothing and this throws, rather than the move silently skipping the step.
 *
 * @param {string} legacyRedirectsPath Absolute path to the module declaring both maps.
 * @param {Record<string, number>} changed Textual substitution count per map name.
 */
export async function assertLegacyDestinationsRewrite(
  legacyRedirectsPath,
  oldUrl,
  newUrl,
  changed,
) {
  let mod;
  try {
    mod = await import(pathToFileURL(legacyRedirectsPath).href);
  } catch (err) {
    throw new Error(
      `legacy-destinations: could not import ${LEGACY_REDIRECTS_PATH} to verify the destination ` +
        `rewrite: ${err.message}`,
    );
  }
  for (const name of DESTINATION_MAPS) {
    const expected = [...(mod[name] ?? new Map()).values()].filter(
      (destination) => pageOf(destination) === oldUrl,
    ).length;
    if (expected !== (changed[name] ?? 0)) {
      throw new Error(
        `legacy-destinations: ${name} rewrite of '${oldUrl}' -> '${newUrl}' changed ` +
          `${changed[name] ?? 0} value(s) but the parsed map names it ${expected} time(s). The ` +
          `rewrite is textual and single-quote-only, so this usually means ${LEGACY_REDIRECTS_PATH} ` +
          `was reformatted (double quotes, a template literal, or a differently shaped declaration) ` +
          `and no longer matches. Retarget the entries by hand, then teach rewriteDestinationMap the ` +
          `new shape. Nothing was written; move-doc runs this step last, so in a real run the file ` +
          `move, the link rewrites, meta.json and the redirect have already landed.`,
      );
    }
  }
}

/**
 * Run contents through Prettier so a retarget never carries collateral reformatting: moving a value
 * changes its length, and Prettier is what decides whether the entry now fits on one line or has to
 * wrap. Writing the raw substitution would leave the file failing `pnpm format:check`, which is a
 * blocking gate. Same `resolveConfig` + `format` shape as `drift-maps.mjs` and
 * `scripts/generate-legacy-redirects.mjs`. Formatting is deliberately separate from writing.
 */
async function formatFor(filePath, contents) {
  const config = await resolveConfig(filePath);
  return format(contents, { ...config, filepath: filePath });
}

/**
 * The source URLs of every `AUTO-GENERATED` redirect in `redirects.config.mjs` whose destination is
 * `url`: the entries an earlier `move-doc` run wrote, which moving `url` turns into a two-hop chain.
 * Read-only, and the reason the CLI can say something true about that block instead of asserting a
 * chain that usually is not there (the block holds four entries today).
 *
 * Four properties make the match sound, and each is pinned by a test:
 *
 *  - **Bounded by the two markers**, so a hand-written entry or a `legacyRedirects` spread outside
 *    the block is never named. Retargeting those is not `move-doc`'s business.
 *  - **Exact string equality on the destination**, not a prefix test, so moving `/docs/run-a-node`
 *    does not claim the entry pointing at `/docs/run-a-node/run-batch-poster`.
 *  - **`source` then `destination`, in that order**, which is what `appendRedirect` writes and what
 *    Prettier preserves when it wraps an entry onto several lines. `\s*` spans those newlines, so
 *    both layouts match.
 *  - **The moved page's own redirect cannot match itself.** `move-doc` appends `oldUrl -> newUrl`
 *    before this runs, and that entry's destination is the *new* URL.
 */
export function findChainedAutoRedirects(repoRoot, url) {
  if (!url) return [];
  const configPath = path.join(repoRoot, REDIRECTS_CONFIG_PATH);
  if (!existsSync(configPath)) return [];

  const contents = readFileSync(configPath, 'utf8');
  const start = contents.indexOf(REDIRECTS_START);
  const end = contents.indexOf(REDIRECTS_END);
  if (start === -1 || end === -1 || end < start) return [];

  const block = contents.slice(start + REDIRECTS_START.length, end);
  const entry = /source:\s*'((?:[^'\\]|\\.)*)'\s*,\s*destination:\s*'((?:[^'\\]|\\.)*)'/g;
  return [...block.matchAll(entry)].filter((m) => m[2] === url).map((m) => m[1]);
}

/**
 * The CLI note for those chained entries, or null when there are none. Separate from the
 * `redirects.legacy.mjs` note because the two are independent: this one is about an earlier move's
 * own redirect, so it holds whether or not either legacy map names the page, and it lives in a
 * different file from the legacy map, so the two are retargeted separately.
 */
function chainedRedirectNote(repoRoot, oldUrl, newUrl) {
  const sources = findChainedAutoRedirects(repoRoot, oldUrl);
  if (!sources.length) return null;
  const list = sources.map((s) => `'${s}'`).join(', ');
  return (
    `NOTE: the AUTO-GENERATED block in ${REDIRECTS_CONFIG_PATH} has ${sources.length} redirect(s) ` +
    `pointing at '${oldUrl}' (from ${list}), so each of them now chains on to '${newUrl}', ` +
    `correct for readers, but one hop longer, and \`pnpm redirects:check\` follows only one hop, ` +
    `so it reports each of them DEAD. They live in this file, not redirects.legacy.mjs: retarget ` +
    `them to '${newUrl}'.`
  );
}

/**
 * Retarget both maps in the repo at `repoRoot`, in place, unless `dryRun`. Returns human-readable
 * notes for the CLI to print — empty when neither map references the moved page. Mirrors
 * `updateDriftMaps`: notes describe the same change whether or not `dryRun` is set, so a dry run
 * reports exactly what a real run would do.
 *
 * Every read, rewrite, verification and Prettier pass happens before the single `writeFileSync`.
 *
 * @param {string} repoRoot Absolute repo root (move-doc always runs with `process.cwd()` as this).
 * @param {string|null} oldUrl The moved page's old site URL (`/docs/...`), or null for a partial.
 * @param {string|null} newUrl Its new site URL, or null.
 * @param {boolean} dryRun
 * @returns {Promise<string[]>}
 */
export async function updateLegacyDestinations(repoRoot, oldUrl, newUrl, dryRun) {
  // A partial has no URL, and a move that does not change the URL cannot orphan a destination.
  if (!oldUrl || !newUrl || oldUrl === newUrl) return [];

  // Computed first, and reported even when neither map named the page: an earlier move's chained
  // redirect has nothing to do with the two legacy maps, so gating it on one of them changing would
  // stay silent exactly where there is no other signal.
  const chained = chainedRedirectNote(repoRoot, oldUrl, newUrl);

  const legacyRedirectsPath = path.join(repoRoot, LEGACY_REDIRECTS_PATH);
  if (!existsSync(legacyRedirectsPath)) return chained ? [chained] : [];

  const notes = [];
  const changed = {};
  let source = readFileSync(legacyRedirectsPath, 'utf8');
  for (const name of DESTINATION_MAPS) {
    const result = rewriteDestinationMap(source, name, oldUrl, newUrl);
    source = result.source;
    changed[name] = result.changed;
  }

  // Throws when a textual count and the parsed map disagree, before anything is written.
  await assertLegacyDestinationsRewrite(legacyRedirectsPath, oldUrl, newUrl, changed);

  const total = DESTINATION_MAPS.reduce((n, name) => n + changed[name], 0);
  if (!total) {
    if (chained) notes.push(chained);
    return notes;
  }

  const formatted = await formatFor(legacyRedirectsPath, source);
  for (const name of DESTINATION_MAPS) {
    if (changed[name]) {
      notes.push(
        `${LEGACY_REDIRECTS_PATH}: retargeted ${changed[name]} ${name} destination(s) '${oldUrl}' -> '${newUrl}'`,
      );
    }
  }
  notes.push(
    `NOTE: redirects.legacy.mjs still sends those legacy URLs to '${oldUrl}', which now redirects on ` +
      `to '${newUrl}', correct for readers, but one hop longer, and \`pnpm redirects:check\` follows ` +
      `only one hop, so it reports each of them DEAD. That file is hand-maintained now: retarget ` +
      `those entries to '${newUrl}', or accept the extra hop and the DEAD report.`,
  );
  if (chained) notes.push(chained);

  if (!dryRun) writeFileSync(legacyRedirectsPath, formatted);

  return notes;
}
