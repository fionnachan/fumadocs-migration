/**
 * redirects-config — the one redirect file, `redirects.config.mjs`, and what `move-doc` does to it.
 *
 * Every redirect on this site lives in that file: an `AUTO-GENERATED` block that `move-doc` appends a
 * moved page's own `old -> new` entry to, and the hand-maintained legacy `docs.arbitrum.io` entries
 * after it. Because there is one file, a page move has exactly one follow-up: every entry whose
 * destination was the old URL is retargeted to the new one, so no redirect ever chains through a
 * second redirect. Next serves one redirect per request, so a chain would still reach the page, but
 * `pnpm redirects:check` follows one hop only and would report every chained entry DEAD.
 *
 * The retarget is textual and deliberately narrow: it matches `destination: '<oldUrl>'`, with an
 * optional `#anchor` carried across, and nothing else. A `source:` can never match, because the
 * pattern starts with the `destination:` key, and `/docs/get-started` cannot match inside
 * `/docs/get-started/child`, because the closing quote has to follow immediately.
 *
 * Declared here rather than in `move-doc.mjs` because `move-doc.mjs` runs its `main()` on import, so
 * nothing can import constants back out of it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  const re = new RegExp(`(destination:\\s*)'${escapeRegExp(oldUrl)}(#[^']*)?'`, 'g');
  let changed = 0;
  const next = source.replace(re, (_m, key, anchor) => {
    changed++;
    return `${key}'${newUrl}${anchor ?? ''}'`;
  });
  return { source: changed ? next : source, changed };
}

/**
 * Retarget the repo's `redirects.config.mjs` in place for a page moved from `oldUrl` to `newUrl`,
 * unless `dryRun`. Returns human-readable notes for the CLI, and none when no entry named the page.
 * A partial (no URL) and a move that keeps its URL are no-ops.
 *
 * @param {string} repoRoot
 * @param {string|null} oldUrl
 * @param {string|null} newUrl
 * @param {boolean} dryRun
 * @returns {string[]}
 */
export function retargetRedirects(repoRoot, oldUrl, newUrl, dryRun) {
  if (!oldUrl || !newUrl || oldUrl === newUrl) return [];
  const configPath = path.join(repoRoot, REDIRECTS_CONFIG_PATH);
  if (!existsSync(configPath)) return [];
  const { source, changed } = retargetDestinations(
    readFileSync(configPath, 'utf8'),
    oldUrl,
    newUrl,
  );
  if (!changed) return [];
  if (!dryRun) writeFileSync(configPath, source);
  return [
    `${REDIRECTS_CONFIG_PATH}: retargeted ${changed} existing redirect(s) '${oldUrl}' -> '${newUrl}'`,
  ];
}
