/**
 * drift-maps — keep `scripts/lib/tree-compare.mjs`'s `RENAME_MAP` and
 * `scripts/data/upstream.config.json`'s `guttedAllowlist` in sync with `move-doc`.
 *
 * Both files name local (content/docs-relative) paths that `move-doc` otherwise has no idea exist:
 * `RENAME_MAP`'s *values* (the Tree B path a renamed upstream page maps to, including the `to` field
 * of a `merge: true` entry) and `guttedAllowlist`'s `local` field. Moving one of those pages without
 * updating these leaves a stale path — `scripts/upstream-drift.test.mjs` catches it ("every RENAME_MAP
 * target and every allowlist `local` path is a file that exists"), but only in whatever PR happens to
 * run `pnpm test` next, which is rarely the move itself, so it fails Gates in an unrelated PR. This
 * module makes `move-doc` fix it in the same commit as the move.
 *
 * `RENAME_MAP` keys are upstream (Tree A) paths and are never touched here — only local paths move.
 * `absentAllowlist` has no `local` field (it names only an upstream path that was deliberately never
 * ported), so a local move never needs to touch it.
 *
 * Three properties this module goes out of its way to hold, each of them a way a textual rewrite can
 * otherwise be wrong without saying so:
 *
 *  - **It only ever edits inside the `RENAME_MAP` object literal.** `tree-compare.mjs` also declares
 *    `SECTION_MAP`, whose *values* are bare section prefixes (`'stylus'`, `'oracles'`, `'run-a-node'`).
 *    A whole-file regex for a top-level page's path would rewrite one of those and silently remap an
 *    entire upstream section, while reporting it on the CLI as a `RENAME_MAP` change.
 *  - **A missed match is loud.** The rewrite is textual and single-quote-only, so a reformat of
 *    `tree-compare.mjs` to double quotes, or an entry written as a template literal, would match
 *    nothing and leave the stale path in place, reintroducing exactly the bug this module fixes with
 *    no warning. `assertRenameMapRewrite` imports the module and checks the textual change count
 *    against the real parsed map, so a miss throws instead of passing silently.
 *  - **Nothing is written until every rewrite, and its Prettier pass, has succeeded.** A throw part
 *    way through would otherwise leave one map written and the other not.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';

export const TREE_COMPARE_PATH = path.join('scripts', 'lib', 'tree-compare.mjs');
export const UPSTREAM_CONFIG_PATH = path.join('scripts', 'data', 'upstream.config.json');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The Tree B path a `RENAME_MAP` value points at, for either supported shape (mirrors `tree-compare`). */
function renameTarget(value) {
  return typeof value === 'string' ? value : value?.to;
}

/**
 * The `[start, end)` offsets of the body of the `RENAME_MAP` object literal in `source`, or `null`
 * when the declaration is not found in the shape this module knows how to edit.
 *
 * Confining the rewrite to this range is what keeps `SECTION_MAP`, and every other string in the
 * file, out of reach. Finding nothing here is not an error on its own: it means zero textual changes,
 * which `assertRenameMapRewrite` then compares against the parsed map and rejects if the map really
 * did name the moved page.
 */
function renameMapRange(source) {
  const start = /^export const RENAME_MAP = \{$/m.exec(source);
  if (!start) return null;
  const from = start.index + start[0].length;
  const end = source.indexOf('\n};', from);
  return end === -1 ? null : [from, end];
}

/**
 * Rewrite every `RENAME_MAP` *value* in `source` that names `oldRel` to name `newRel` instead — both
 * the plain-string form (`'key': 'value'`, possibly split across two lines when the key is long) and
 * the `{ to: 'value', merge: true }` form. Only the `RENAME_MAP` literal is touched.
 *
 * A quoted string in that literal is a value, never a key, exactly when it is not immediately
 * followed by `:` — keys always are. That is enough to tell the two apart without parsing the module
 * as an AST, and it is the reason this only ever touches values.
 *
 * @returns {{ source: string, changed: number }}
 */
export function rewriteRenameMapSource(source, oldRel, newRel) {
  const range = renameMapRange(source);
  if (!range) return { source, changed: 0 };
  const [from, to] = range;
  let changed = 0;
  const re = new RegExp(`'${escapeRegExp(oldRel)}'(?!\\s*:)`, 'g');
  const body = source.slice(from, to).replace(re, () => {
    changed++;
    return `'${newRel}'`;
  });
  return { source: changed ? source.slice(0, from) + body + source.slice(to) : source, changed };
}

/**
 * Cross-check the textual rewrite against the module's own parsed `RENAME_MAP`, and report a target
 * collision the move would create.
 *
 * Imports `treeComparePath` (an ordinary side-effect-free ESM module) and counts, structurally, how
 * many entries point at `oldRel`. If that count does not equal the number of textual substitutions,
 * the regex missed an entry it should have hit, or hit one it should not have, and the whole move is
 * aborted rather than left with a half-retargeted map.
 *
 * @returns {Promise<string[]>} warnings to surface (never fatal on their own)
 */
export async function assertRenameMapRewrite(treeComparePath, oldRel, newRel, changed) {
  let mod;
  try {
    mod = await import(pathToFileURL(treeComparePath).href);
  } catch (err) {
    throw new Error(
      `drift-maps: could not import ${TREE_COMPARE_PATH} to verify the RENAME_MAP rewrite: ${err.message}`,
    );
  }
  const targets = Object.entries(mod.RENAME_MAP ?? {}).map(([key, value]) => [
    key,
    renameTarget(value),
  ]);
  const expected = targets.filter(([, target]) => target === oldRel).length;
  if (expected !== changed) {
    throw new Error(
      `drift-maps: RENAME_MAP rewrite of '${oldRel}' -> '${newRel}' changed ${changed} value(s) but ` +
        `the parsed map names it ${expected} time(s). The rewrite is textual and single-quote-only, so ` +
        `this usually means ${TREE_COMPARE_PATH} was reformatted (double quotes, a template literal, or ` +
        `a differently shaped declaration) and no longer matches. Retarget the entries by hand, then ` +
        `teach rewriteRenameMapSource the new shape. No files were changed.`,
    );
  }
  // A move onto a path another entry already targets leaves two upstream pages claiming one Tree B
  // file, which `pairTrees` rejects unless both declare `merge: true`. Warn rather than throw: the
  // move itself is legitimate, and the fix belongs in RENAME_MAP, not here.
  const collisions = targets.filter(([, target]) => target === newRel).map(([key]) => key);
  return collisions.length
    ? [
        `WARNING: ${TREE_COMPARE_PATH}: '${newRel}' is already a RENAME_MAP target of ` +
          `${collisions.map((k) => `'${k}'`).join(', ')}. Two upstream pages now claim one local file; ` +
          `pairTrees rejects that unless every entry involved declares 'merge: true'.`,
      ]
    : [];
}

/**
 * Rewrite every `guttedAllowlist` entry's `local` field in parsed `upstream.config.json` text that
 * names `oldRel` to name `newRel`, re-serializing with the same 2-space indent the file already uses
 * (matches `stringifyMeta` in `doc-links.mjs`). `absentAllowlist` entries have no `local` field and
 * are left untouched; nothing else in the file is touched, because `JSON.stringify` round-trips key
 * order and every other value unchanged.
 *
 * @returns {{ text: string, changed: number }}
 */
export function rewriteUpstreamConfig(text, oldRel, newRel) {
  const data = JSON.parse(text);
  let changed = 0;
  for (const entry of data.guttedAllowlist ?? []) {
    if (entry.local === oldRel) {
      entry.local = newRel;
      changed++;
    }
  }
  return { text: changed ? JSON.stringify(data, null, 2) + '\n' : text, changed };
}

/**
 * Run contents through Prettier so a retarget never carries collateral reformatting:
 * `rewriteUpstreamConfig` re-serializes the whole file with a plain 2-space `JSON.stringify`, which
 * does not know that Prettier collapses a short array like `probePaths` onto one line, so writing its
 * output directly would turn one field's worth of intent into a diff that also re-wraps unrelated
 * arrays. Same `resolveConfig` + `format` shape as `scripts/generate-legacy-redirects.mjs` uses for
 * its generated output. Formatting is deliberately separate from writing, so a formatter failure
 * cannot leave one map written and the other not.
 */
async function formatFor(filePath, contents) {
  const config = await resolveConfig(filePath);
  return format(contents, { ...config, filepath: filePath });
}

/**
 * Apply both rewrites in the repo at `repoRoot`, in place, unless `dryRun`. Returns human-readable
 * notes for the CLI to print — empty when neither file references the moved path. Mirrors the shape
 * of `updateMeta` in `move-doc.mjs`: notes describe the same change whether or not `dryRun` is set, so
 * a dry run reports exactly what a real run would do.
 *
 * Every read, rewrite, verification and Prettier pass happens before the first `writeFileSync`, so
 * this step either writes both maps or neither. `move-doc` runs it last, after the redirect is
 * appended, so a throw here cannot cost an earlier step.
 *
 * @param {string} repoRoot Absolute repo root (move-doc always runs with `process.cwd()` as this).
 * @param {string} oldRel Old path, relative to `content/docs`, posix-separated.
 * @param {string} newRel New path, relative to `content/docs`, posix-separated.
 * @param {boolean} dryRun
 * @returns {Promise<string[]>}
 */
export async function updateDriftMaps(repoRoot, oldRel, newRel, dryRun) {
  const notes = [];
  const writes = [];
  const treeComparePath = path.join(repoRoot, TREE_COMPARE_PATH);
  const upstreamConfigPath = path.join(repoRoot, UPSTREAM_CONFIG_PATH);

  if (existsSync(treeComparePath)) {
    const source = readFileSync(treeComparePath, 'utf8');
    const { source: next, changed } = rewriteRenameMapSource(source, oldRel, newRel);
    // Throws when the textual count and the parsed map disagree, before anything is written.
    const warnings = await assertRenameMapRewrite(treeComparePath, oldRel, newRel, changed);
    if (changed) {
      writes.push([treeComparePath, await formatFor(treeComparePath, next)]);
      notes.push(
        `${TREE_COMPARE_PATH}: retargeted ${changed} RENAME_MAP value(s) '${oldRel}' -> '${newRel}'`,
      );
    }
    notes.push(...warnings);
  }

  if (existsSync(upstreamConfigPath)) {
    const text = readFileSync(upstreamConfigPath, 'utf8');
    const { text: next, changed } = rewriteUpstreamConfig(text, oldRel, newRel);
    if (changed) {
      writes.push([upstreamConfigPath, await formatFor(upstreamConfigPath, next)]);
      notes.push(
        `${UPSTREAM_CONFIG_PATH}: retargeted ${changed} guttedAllowlist 'local' path(s) '${oldRel}' -> '${newRel}'`,
      );
    }
  }

  if (!dryRun) for (const [filePath, contents] of writes) writeFileSync(filePath, contents);

  return notes;
}
