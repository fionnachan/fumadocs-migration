/**
 * Pre-commit checks, scoped to staged files only. Run via `.husky/pre-commit`.
 *
 * - Prettier formats every staged file type it understands, except `meta.json` (see below).
 * - Staged MDX under content/ gets prettier, then scripts/content-lint.mjs, restricted to those
 *   files (see the `files` option on `lintContent` in scripts/lib/content-lint.mjs) so a
 *   single-file commit does not pay for a full content-tree walk. The two run as one array entry,
 *   in sequence, because lint-staged runs separate glob entries concurrently by default (see
 *   `runParallelTasks` in lint-staged), and prettier and content-lint would otherwise race on the
 *   same file: content-lint could read the file mid-rewrite, or prettier could get killed
 *   part-way through a write when content-lint fails first.
 * - content-lint runs with `--rule=A1,A3,A4` only, the three rules with zero findings across the
 *   whole tree today. `A2` and `A5` still have pre-existing findings tracked as non-blocking
 *   `Content debt` in CI (see the job comment in .github/workflows/ci.yml); making the full rule
 *   set blocking here would reject a commit over a defect the contributor did not introduce, with
 *   `--no-verify` as the only way out. Widen this list as each rule's CI count reaches zero, the
 *   same rule that promotes a step from `Content debt` into `Gates`.
 * - A staged .ts/.tsx file triggers one full `pnpm types:check` for the whole project, the
 *   `() => …` function form runs once regardless of how many files matched, not once per file.
 *   Plain `tsc --noEmit` is not enough here: Next's route-handler types (e.g. `RouteContext`) and
 *   the fumadocs-mdx `.source/` collection are both generated files, and `tsc` alone fails on a
 *   fresh checkout with no `.next/types` yet. `types:check` runs `fumadocs-mdx && next typegen`
 *   first for exactly that reason (see package.json), so the hook reuses it rather than
 *   re-deriving a shorter, subtly wrong command. This is also the slow path: it regenerates
 *   `.source/`, runs `next typegen`, then type-checks the whole project, so even a one-line `.ts`
 *   edit pays for a full run, not just for the file you touched.
 */
export default {
  '*.{js,mjs,ts,tsx,md,yml,yaml,css}': 'prettier --write',
  // Every *.json file except meta.json. meta.json is generator output (`stringifyMeta` in
  // scripts/lib/doc-links.mjs), which writes one array entry per line on purpose; Prettier
  // collapses a short array onto one line, so formatting it here would fight `pnpm move-doc` on
  // every run, each undoing the other's style. format:check already tracks the resulting debt as
  // non-blocking Content debt, so leaving meta.json unformatted here does not hide anything new.
  '!(meta).json': 'prettier --write',
  'content/**/*.mdx': (files) => [
    `prettier --write ${files.map((f) => `"${f}"`).join(' ')}`,
    `node scripts/content-lint.mjs --rule=A1,A3,A4 ${files.map((f) => `"${f}"`).join(' ')}`,
  ],
  '*.{ts,tsx}': () => 'pnpm run types:check',
};
