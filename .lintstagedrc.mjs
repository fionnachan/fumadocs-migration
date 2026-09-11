/**
 * Pre-commit checks, scoped to staged files only. Run via `.husky/pre-commit`.
 *
 * - Prettier formats every staged file type it understands.
 * - Staged MDX under content/ also gets scripts/content-lint.mjs, restricted to those files
 *   (see the `files` option on `lintContent` in scripts/lib/content-lint.mjs) so a single-file
 *   commit does not pay for a full content-tree walk.
 * - A staged .ts/.tsx file triggers one full `pnpm types:check` for the whole project — the
 *   `() => …` function form runs once regardless of how many files matched, not once per file.
 *   Plain `tsc --noEmit` is not enough here: Next's route-handler types (e.g. `RouteContext`) and
 *   the fumadocs-mdx `.source/` collection are both generated files, and `tsc` alone fails on a
 *   fresh checkout with no `.next/types` yet. `types:check` runs `fumadocs-mdx && next typegen`
 *   first for exactly that reason (see package.json), so the hook reuses it rather than
 *   re-deriving a shorter, subtly wrong command.
 */
export default {
  '*.{js,mjs,ts,tsx,json,md,mdx,css}': 'prettier --write',
  'content/**/*.mdx': (files) =>
    `node scripts/content-lint.mjs ${files.map((f) => `"${f}"`).join(' ')}`,
  '*.{ts,tsx}': () => 'pnpm run types:check',
};
