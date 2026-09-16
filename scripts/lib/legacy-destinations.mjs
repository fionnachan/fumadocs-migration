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
 * **This module outlives the legacy redirect *generator*.** The generator half — the code that reads
 * a sibling arbitrum-docs checkout to derive upstream's URL corpus (`upstream-pages.mjs`,
 * `resolveUpstreamRepo`, `build`) — is scheduled for deletion once this repo replaces upstream and
 * upstream is archived. The two maps are not: docs.arbitrum.io URLs have to keep resolving forever,
 * so the hand-maintained overlay and `resolveTarget`'s ordering are permanent. Accordingly this
 * module reads nothing but the two named exports and rewrites nothing but the two object literals
 * that declare them. It never calls `build()`, never touches `upstream.config.json`, `vercel.json`,
 * or any upstream checkout, and so needs no change the day the generator is deleted.
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
 * What this module does *not* do is regenerate `redirects.legacy.mjs`. That is generator output, and
 * regenerating it needs the sibling checkout this module refuses to depend on — a move would then
 * fail for anyone without one. It does not have to: `move-doc` appends `oldUrl -> newUrl` to
 * `redirects.config.mjs`, and Next serves one redirect per request, so a legacy URL still reaches the
 * moved page in two hops. The note printed on the CLI says to run `pnpm redirects:legacy` to collapse
 * the hop back to one.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';

export const LEGACY_REDIRECTS_PATH = path.join('scripts', 'lib', 'legacy-redirects.mjs');

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
          `move, the link rewrites, meta.json, the redirect and the drift maps have already landed.`,
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

  const legacyRedirectsPath = path.join(repoRoot, LEGACY_REDIRECTS_PATH);
  if (!existsSync(legacyRedirectsPath)) return [];

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
  if (!total) return notes;

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
      `to '${newUrl}' — correct, but one hop longer. Run \`pnpm redirects:legacy\` (needs a sibling ` +
      `arbitrum-docs checkout) to collapse it.`,
  );

  if (!dryRun) writeFileSync(legacyRedirectsPath, formatted);

  return notes;
}
