/**
 * redirects-config: the one redirect file, `redirects.config.mjs`, and what `move-doc` does to it.
 *
 * Every redirect on this site lives in that file: an `AUTO-GENERATED` block that `move-doc` appends a
 * moved page's own `old -> new` entry to, and the hand-maintained legacy `docs.arbitrum.io` entries
 * after it. Because there is one file, a page move has exactly two follow-ups, both done here:
 *
 *  - every entry whose destination was the old URL is retargeted to the new one, so no redirect
 *    chains through a second redirect. Next serves one redirect per request, so a chain would still
 *    reach the page, but `pnpm redirects:check` follows one hop only and would report every chained
 *    entry DEAD;
 *  - every entry whose *source* is the new URL is deleted, because a page lives there now and Next
 *    runs `redirects()` before routing, so such an entry would shadow the page. This is the
 *    out-and-back move: `X -> Y` is on file from an earlier move, the page comes back to `X`, and
 *    without this step the retarget would leave `X -> X`, a redirect loop on the restored page.
 *
 * Both rewrites are textual and deliberately narrow, and accept either quote style so a Prettier
 * config change cannot make them miss. The retarget matches `destination: '<oldUrl>'`
 * with an optional `#anchor` carried across; a `source:` can never match, because the pattern starts
 * with the `destination:` key, and `/docs/get-started` cannot match inside `/docs/get-started/child`,
 * because the closing quote has to follow immediately. The deletion matches one whole
 * `{ source, destination, permanent }` entry in the key order `appendRedirect` writes, on one line
 * or wrapped by Prettier. The result is run through Prettier before it is written, so a retarget
 * that changes a value's length cannot leave the file failing `pnpm format:check`.
 *
 * Declared here rather than in `move-doc.mjs` because `move-doc.mjs` runs its `main()` on import, so
 * nothing can import constants back out of it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';

export const REDIRECTS_CONFIG_PATH = 'redirects.config.mjs';
export const REDIRECTS_START = '// AUTO-GENERATED REDIRECTS START';
export const REDIRECTS_END = '// AUTO-GENERATED REDIRECTS END';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite every `destination: '<oldUrl>'` (optionally `#anchored`) in `source` to `newUrl`.
 *
 * @returns {{ source: string, changed: number }}
 */
export function retargetDestinations(source, oldUrl, newUrl) {
  const re = new RegExp(`(destination:\\s*)(['"])${escapeRegExp(oldUrl)}(#[^'"]*)?\\2`, 'g');
  let changed = 0;
  const next = source.replace(re, (_m, key, quote, anchor) => {
    changed++;
    return `${key}${quote}${newUrl}${anchor ?? ''}${quote}`;
  });
  return { source: changed ? next : source, changed };
}

/**
 * Delete every whole entry in `source` whose `source:` is `url`. Returns the destinations of the
 * deleted entries, so the CLI can name them.
 *
 * @returns {{ source: string, removed: string[] }}
 */
export function removeEntriesFrom(source, url) {
  const re = new RegExp(
    `[ \\t]*\\{\\s*source:\\s*(['"])${escapeRegExp(url)}\\1\\s*,\\s*destination:\\s*(['"])([^'"]*)\\2\\s*,` +
      `\\s*permanent:\\s*(?:true|false)\\s*,?\\s*\\},?[ \\t]*\\n?`,
    'g',
  );
  const removed = [];
  const next = source.replace(re, (_m, _q1, _q2, destination) => {
    removed.push(destination);
    return '';
  });
  return { source: removed.length ? next : source, removed };
}

/**
 * Bring the repo's `redirects.config.mjs` up to date with a page moved from `oldUrl` to `newUrl`:
 * retarget every entry that pointed at the old URL, delete every entry whose source is the new URL,
 * format, and write, unless `dryRun`. Returns human-readable notes for the CLI, and none when
 * nothing needed changing. A partial (no URL) and a move that keeps its URL are no-ops.
 *
 * @param {string} repoRoot
 * @param {string|null} oldUrl
 * @param {string|null} newUrl
 * @param {boolean} dryRun
 * @returns {Promise<string[]>}
 */
export async function retargetRedirects(repoRoot, oldUrl, newUrl, dryRun) {
  if (!oldUrl || !newUrl || oldUrl === newUrl) return [];
  const configPath = path.join(repoRoot, REDIRECTS_CONFIG_PATH);
  if (!existsSync(configPath)) return [];

  // Removal first, so the note names the entry as it was on file rather than after the retarget
  // has rewritten its destination. The two rewrites touch disjoint text (whole entries by source,
  // and destination values), so the order changes nothing else.
  const cleaned = removeEntriesFrom(readFileSync(configPath, 'utf8'), newUrl);
  const retargeted = retargetDestinations(cleaned.source, oldUrl, newUrl);
  if (!retargeted.changed && !cleaned.removed.length) return [];

  const notes = [];
  if (retargeted.changed) {
    notes.push(
      `${REDIRECTS_CONFIG_PATH}: retargeted ${retargeted.changed} existing redirect(s) '${oldUrl}' -> '${newUrl}'`,
    );
  }
  for (const destination of cleaned.removed) {
    notes.push(
      `${REDIRECTS_CONFIG_PATH}: removed '${newUrl}' -> '${destination}', which would have shadowed the page now at '${newUrl}'`,
    );
  }

  if (!dryRun) {
    const config = await resolveConfig(configPath);
    writeFileSync(configPath, await format(retargeted.source, { ...config, filepath: configPath }));
  }
  return notes;
}
