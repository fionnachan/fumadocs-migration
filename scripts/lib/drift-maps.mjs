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
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const TREE_COMPARE_PATH = path.join('scripts', 'lib', 'tree-compare.mjs');
export const UPSTREAM_CONFIG_PATH = path.join('scripts', 'data', 'upstream.config.json');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Candidate literal forms of a local doc path as it might appear in `tree-compare.mjs`: its real
 * extension, and (defensively) the same path with the extension stripped, in case an entry is ever
 * written without one. Every real entry today carries `.mdx`, so this only matters for the future.
 */
function pathForms(rel) {
  const noExt = rel.replace(/\.mdx?$/i, '');
  return noExt === rel ? [rel] : [rel, noExt];
}

/**
 * Rewrite every `RENAME_MAP` *value* in `source` that names `oldRel` to name `newRel` instead — both
 * the plain-string form (`'key': 'value'`, possibly split across two lines when the key is long) and
 * the `{ to: 'value', merge: true }` form.
 *
 * A quoted string in this module is a value, never a key, exactly when it is not immediately followed
 * by `:` — keys always are. That is enough to tell the two apart without parsing the module as an
 * AST, and it is the reason this only ever touches values.
 *
 * @returns {{ source: string, changed: number }}
 */
export function rewriteRenameMapSource(source, oldRel, newRel) {
  let next = source;
  let changed = 0;
  const oldForms = pathForms(oldRel);
  const newForms = pathForms(newRel);
  for (let i = 0; i < oldForms.length; i++) {
    const oldForm = oldForms[i];
    const newForm = newForms[i] ?? newRel;
    const re = new RegExp(`'${escapeRegExp(oldForm)}'(?!\\s*:)`, 'g');
    next = next.replace(re, () => {
      changed++;
      return `'${newForm}'`;
    });
  }
  return { source: next, changed };
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
 * Apply both rewrites in the repo at `repoRoot`, in place, unless `dryRun`. Returns human-readable
 * notes for the CLI to print — empty when neither file references the moved path. Mirrors the shape
 * of `updateMeta` in `move-doc.mjs`: notes describe the same change whether or not `dryRun` is set, so
 * a dry run reports exactly what a real run would do.
 *
 * @param {string} repoRoot Absolute repo root (move-doc always runs with `process.cwd()` as this).
 * @param {string} oldRel Old path, relative to `content/docs`, posix-separated.
 * @param {string} newRel New path, relative to `content/docs`, posix-separated.
 * @param {boolean} dryRun
 * @returns {string[]}
 */
export function updateDriftMaps(repoRoot, oldRel, newRel, dryRun) {
  const notes = [];
  const treeComparePath = path.join(repoRoot, TREE_COMPARE_PATH);
  const upstreamConfigPath = path.join(repoRoot, UPSTREAM_CONFIG_PATH);

  if (existsSync(treeComparePath)) {
    const source = readFileSync(treeComparePath, 'utf8');
    const { source: next, changed } = rewriteRenameMapSource(source, oldRel, newRel);
    if (changed) {
      if (!dryRun) writeFileSync(treeComparePath, next);
      notes.push(
        `${TREE_COMPARE_PATH}: retargeted ${changed} RENAME_MAP value(s) '${oldRel}' -> '${newRel}'`,
      );
    }
  }

  if (existsSync(upstreamConfigPath)) {
    const text = readFileSync(upstreamConfigPath, 'utf8');
    const { text: next, changed } = rewriteUpstreamConfig(text, oldRel, newRel);
    if (changed) {
      if (!dryRun) writeFileSync(upstreamConfigPath, next);
      notes.push(
        `${UPSTREAM_CONFIG_PATH}: retargeted ${changed} guttedAllowlist 'local' path(s) '${oldRel}' -> '${newRel}'`,
      );
    }
  }

  return notes;
}
