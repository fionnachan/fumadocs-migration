/**
 * migrate-glossary — sync Docusaurus glossary term partials into the Fumadocs reference
 * collection at content/glossary/. Originally a one-shot port; now idempotent and rerunnable so
 * it can resync content/glossary/ against upstream as upstream's terms change.
 *
 * Each upstream source file (docs/partials/glossary/_*.mdx) has frontmatter `key`, `title`,
 * `titleforSort`. We reshape to the reference schema (`id`, `title`, `sortAs?`) — see
 * .claude/docs/superpowers/specs/2026-07-10-references-glossary-design.md — and name the output
 * by `id` (the Docusaurus `key`), not the source filename: the source names don't always match
 * their keys (e.g. `_l1.mdx` has `key: L1`).
 *
 * Usage:
 *   node scripts/migrate-glossary.mjs [--upstream <path>] [--dry-run]
 *
 * `--dry-run` prints the three comparison sets (upstream-only, local-only, changed) and writes
 * nothing. Without it, upstream-only terms are added and changed terms are overwritten; local-only
 * terms (a term that exists here but not upstream) are never touched or deleted — the script only
 * ever reports them, because deciding whether to keep a local-only term is an editorial call, not
 * a mechanical one.
 *
 * Upstream path resolution is delegated to scripts/lib/upstream-tree.mjs, the shared resolver every
 * upstream-comparing script uses, so the order stays defined in one place:
 *   1. --upstream <path> / --tree-a <path>  (repo root / docs tree, resolved against the cwd)
 *   2. UPSTREAM_DOCS_REPO env var           (repo root, resolved against the cwd)
 *   3. `repo` in scripts/data/upstream.config.json
 *   4. `probePaths` in the same file, first one that exists
 * The last two resolve against THIS repo's root rather than the cwd, which is what makes the script
 * behave the same from the repo root, a subdirectory, or a worktree. The glossary source dir is
 * <docs tree>/partials/glossary.
 *
 * Like `pnpm drift`, the run refuses a clone that is not a trustworthy baseline (never fetched,
 * fetched over 24h ago, or behind its upstream branch). A stale checkout does not make the sync
 * fail, it makes it lie: every term upstream changed since the last fetch looks identical to ours,
 * so "upstream-only (0), changed (0)" reads like a clean run. That applies to --dry-run too, which
 * is why the guard runs before the dry-run branch.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { baselineVerdict, readBaseline } from './lib/git-freshness.mjs';
import {
  describeSearchOrder,
  readUpstreamConfig,
  repoRoot,
  resolveUpstreamTree,
} from './lib/upstream-tree.mjs';

const outDir = path.join(repoRoot, 'content', 'glossary');
const varsPath = path.join(repoRoot, 'content', 'vars.json');

/** Parse a leading `---` frontmatter block into a flat key→value map + the remaining body. */
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { data, body: text.slice(m[0].length) };
}

/** Single-quote a YAML scalar, escaping embedded single quotes. */
export function yamlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Resolve the upstream glossary source via the shared resolver.
 *
 * This script's own flag is `--upstream <repo root>`, which predates the shared `--tree-a <docs
 * tree>` and is what package.json's `glossary:migrate` and the header comment document. Rather than
 * reimplement the precedence, the flag is fed through the resolver's repo-root channel
 * (UPSTREAM_DOCS_REPO), which sits at the same position in the order and resolves against the cwd
 * the same way. `--tree-a` keeps working because the resolver reads it directly.
 *
 * @returns {{docs: string, repo: string, source: string}|null} Absolute paths, or null when nothing resolved.
 */
export function resolveUpstreamRepo(argv, { env = process.env, ...rest } = {}) {
  const idx = argv.indexOf('--upstream');
  const flag = idx !== -1 ? argv[idx + 1] : undefined;
  return resolveUpstreamTree({
    argv,
    env: flag ? { ...env, UPSTREAM_DOCS_REPO: flag } : env,
    ...rest,
  });
}

/** Read every term partial in `srcDir` into a Map<id, {title, sortAs, body, file}>. */
export function readUpstreamTerms(srcDir) {
  const terms = new Map();
  for (const file of readdirSync(srcDir).filter((f) => /\.mdx?$/i.test(f))) {
    const { data, body } = parseFrontmatter(readFileSync(path.join(srcDir, file), 'utf8'));
    if (!data.key) continue; // non-term partial (none exist upstream today, but don't assume)
    if (terms.has(data.key)) {
      console.warn(
        `migrate-glossary: duplicate key "${data.key}" in ${file} (already from ${terms.get(data.key).file})`,
      );
      continue;
    }
    const title = data.title ?? data.key;
    const sortAs = data.titleforSort ?? title;
    terms.set(data.key, { title, sortAs, body, file });
  }
  return terms;
}

/** Read every local reference entry in `dir` into a Map<id, {title, sortAs, body, file}>. */
export function readLocalTerms(dir) {
  const terms = new Map();
  if (!existsSync(dir)) return terms;
  for (const file of readdirSync(dir).filter((f) => /\.mdx?$/i.test(f))) {
    const { data, body } = parseFrontmatter(readFileSync(path.join(dir, file), 'utf8'));
    const id = data.id ?? path.basename(file, path.extname(file));
    terms.set(id, { title: data.title, sortAs: data.sortAs, body, file });
  }
  return terms;
}

/**
 * Normalize a body for content comparison. Link *shape* (markdown URL, `data-quicklook-from`
 * anchor vs. `<Term>`, `.mdx` suffix, `/intro/glossary` vs `/docs/glossary`) reflects mechanical
 * syntax conversion, not real content drift, so both sides are reduced to their visible text
 * before comparing.
 *
 * Variable syntax is stripped on *both* sides for the same reason: upstream writes `@@key@@` and
 * `convertBody` emits `<Var name="key" />`, so stripping only one of them would make the first term
 * to gain a variable compare unequal forever and be rewritten on every run.
 *
 * Case is significant. Case is content — an upstream capitalization fix is a real edit that should
 * sync, and folding it here would hide it.
 */
export function normalizeForComparison(body) {
  return body
    .replace(/<a[^>]*data-quicklook-from=(["']).*?\1[^>]*>([\s\S]*?)<\/a>/g, '$2')
    .replace(/<Term[^>]*>([\s\S]*?)<\/Term>/g, '$1')
    .replace(/<a[^>]*href=(["']).*?\1[^>]*>([\s\S]*?)<\/a>/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/@@[a-zA-Z0-9_.]+@@/g, '')
    .replace(/<Var\s+name=(["'])[a-zA-Z0-9_.]+\1\s*\/>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Load the set of valid `<Var name>` keys from content/vars.json, or an empty set if unreadable. */
function readVarKeys() {
  try {
    const parsed = JSON.parse(readFileSync(varsPath, 'utf8'));
    return new Set(Object.keys(parsed));
  } catch {
    return new Set();
  }
}

/**
 * Convert an upstream glossary body to local MDX:
 *   - `/intro/glossary#id` -> `/docs/glossary#id` (the site's glossary route moved)
 *   - `<a data-quicklook-from="id">text</a>` -> `<Term id="id">text</Term>`
 *   - a link ending in `.mdx`, with or without an `#anchor`, and absolute or relative, is rewritten
 *     to `/docs/<path>#anchor` (extension dropped) when that page exists locally; otherwise left
 *     as-is and reported, since guessing a renamed section would risk a silently wrong link
 *   - `@@key@@` is left untouched unless `key` exists in content/vars.json, per the ticket's
 *     instruction not to introduce a `<Var>` for a var that doesn't exist here
 *
 * Upstream writes doc links in all four combinations of absolute/relative and with/without an
 * anchor, and a shape this doesn't recognize is worse than one it can't resolve: it ships a link
 * that renders relative to `/docs/glossary` and 404s. So anything still holding a `.mdx` link after
 * conversion is warned about, not passed over in silence. Neither blocking gate would catch it —
 * `scripts/lib/doc-links.mjs` walks `content/docs` only, so `content/glossary` is not link-checked.
 */
export function convertBody(
  body,
  {
    varKeys = readVarKeys(),
    docsRoot = path.join(repoRoot, 'content', 'docs'),
    warn = console.warn,
    label = '',
  } = {},
) {
  const where = label ? ` in ${label}` : '';
  // Links the resolver already reported, so the catch-all sweep below does not warn about the same
  // link a second time under a vaguer message.
  const reported = new Set();
  let out = body
    .replace(/\/intro\/glossary/g, '/docs/glossary')
    .replace(
      /<a\s+data-quicklook-from=(["'])([^"']+)\1\s*>([\s\S]*?)<\/a>/g,
      '<Term id="$2">$3</Term>',
    );

  // `[^)#]` keeps the path from swallowing the anchor, which is why the anchor is captured
  // separately rather than left to `[^)]+?`. A leading slash is optional: upstream writes both
  // `/a/b.mdx` and `a/b.mdx`, and both mean the same page relative to the docs root.
  out = out.replace(/\]\((\/?[^)#\s]+?\.mdx)(#[^)\s]*)?\)/g, (match, mdxPath, anchor = '') => {
    const rel = mdxPath.replace(/^\//, '');
    if (!existsSync(path.join(docsRoot, rel))) {
      reported.add(`${mdxPath}${anchor}`);
      warn(
        `migrate-glossary: link target ${mdxPath} not found under content/docs/${where} — left unconverted.`,
      );
      return match;
    }
    return `](/docs/${rel.replace(/\.mdx$/, '')}${anchor})`;
  });

  out = out.replace(/@@([a-zA-Z0-9_.]+)@@/g, (match, key) => {
    if (varKeys.has(key)) return `<Var name="${key}" />`;
    warn(
      `migrate-glossary: "@@${key}@@" has no matching key in content/vars.json${where} — left unconverted.`,
    );
    return match;
  });

  // Catch-all: any `.mdx` link the rules above did not recognize at all. Without this, an
  // unhandled shape is indistinguishable from a correctly converted one.
  for (const [, leftover] of out.matchAll(/\]\(([^)\s]*\.mdx[^)\s]*)\)/g)) {
    if (reported.has(leftover)) continue;
    warn(`migrate-glossary: unconverted .mdx link ${leftover}${where} — check it by hand.`);
  }

  return out;
}

/**
 * The sort key a term compares by. `writeTermFile` omits `sortAs` whenever it equals the title,
 * while `readUpstreamTerms` defaults it to the title, so comparing the raw fields would flag every
 * term that has no explicit sort key. Both sides collapse to the effective key instead.
 */
function effectiveSortAs({ title, sortAs }) {
  return sortAs ?? title;
}

/**
 * Compute the three comparison sets between upstream and local term maps.
 *
 * A term counts as changed when its body, its title, or its effective sort key differs. Frontmatter
 * has to be part of this: `writeTermFile` rewrites the whole file including frontmatter, so a term
 * whose title alone changed upstream would otherwise never be written and never be listed by
 * --dry-run, leaving the collection quietly out of sync with no way to notice.
 */
export function computeSets(upstreamTerms, localTerms) {
  const upstreamIds = new Set(upstreamTerms.keys());
  const localIds = new Set(localTerms.keys());
  const upstreamOnly = [...upstreamIds].filter((id) => !localIds.has(id)).sort();
  const localOnly = [...localIds].filter((id) => !upstreamIds.has(id)).sort();
  const changed = [...upstreamIds]
    .filter((id) => localIds.has(id))
    .filter((id) => {
      const upstream = upstreamTerms.get(id);
      const local = localTerms.get(id);
      return (
        normalizeForComparison(upstream.body) !== normalizeForComparison(local.body) ||
        upstream.title !== local.title ||
        effectiveSortAs(upstream) !== effectiveSortAs(local)
      );
    })
    .sort();
  return { upstreamOnly, localOnly, changed };
}

function writeTermFile(id, { title, sortAs }, body) {
  const frontmatter =
    `---\nid: ${id}\ntitle: ${yamlQuote(title)}` +
    (sortAs && sortAs !== title ? `\nsortAs: ${yamlQuote(sortAs)}` : '') +
    `\n---\n\n`;
  writeFileSync(path.join(outDir, `${id}.mdx`), frontmatter + body.trim() + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  const resolved = resolveUpstreamRepo(argv);
  if (!resolved) {
    console.error('migrate-glossary: could not resolve the upstream repo. Looked, in order, at:');
    for (const where of describeSearchOrder(readUpstreamConfig())) console.error(`  - ${where}`);
    console.error(
      'Pass --upstream <path to the upstream repo>, or clone OffchainLabs/arbitrum-docs next to this repo.',
    );
    process.exitCode = 1;
    return;
  }

  const { docs: upstreamDocs, repo: upstreamRepo } = resolved;

  // The shared resolver walks its candidates and takes the first that exists, so a `--upstream`
  // pointing at a path with no docs tree would quietly resolve to a sibling checkout instead. An
  // explicit flag is an instruction, not a hint: syncing 159 terms from a repo the caller did not
  // name is worse than failing.
  const flagIndex = argv.indexOf('--upstream');
  const flag = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  if (flag && upstreamRepo !== path.resolve(process.cwd(), flag)) {
    console.error(
      `migrate-glossary: --upstream ${flag} has no ${readUpstreamConfig().docsSubdir ?? 'docs'}/ tree; refusing to fall back to ${upstreamRepo}.`,
    );
    process.exitCode = 1;
    return;
  }

  const srcDir = path.join(upstreamDocs, 'partials', 'glossary');
  if (!existsSync(srcDir)) {
    console.error(`migrate-glossary: no glossary partials found at ${srcDir}.`);
    process.exitCode = 1;
    return;
  }

  // Runs before the dry-run branch on purpose: a stale baseline under-reports a dry run exactly as
  // it under-reports a write, and "changed (0)" against a month-old checkout is the failure mode
  // this guard exists to prevent.
  const verdict = baselineVerdict(readBaseline(upstreamRepo));
  for (const w of verdict.warnings)
    console.error(`migrate-glossary: warning: ${upstreamRepo} ${w}`);
  if (!verdict.ok) {
    console.error(
      `migrate-glossary: refusing to run — ${upstreamRepo} is not a trustworthy baseline:`,
    );
    for (const b of verdict.blockers) console.error(`  - ${b}`);
    console.error(`Fix: git -C ${upstreamRepo} pull`);
    console.error('A stale baseline under-reports drift; it does not fail loudly on its own.');
    process.exitCode = 1;
    return;
  }

  const upstreamTerms = readUpstreamTerms(srcDir);
  const localTerms = readLocalTerms(outDir);
  const { upstreamOnly, localOnly, changed } = computeSets(upstreamTerms, localTerms);

  if (dryRun) {
    console.log(
      `migrate-glossary: upstream ${upstreamTerms.size} terms, local ${localTerms.size} terms (source: ${path.relative(repoRoot, srcDir)})\n`,
    );
    console.log(`upstream-only (${upstreamOnly.length}):`);
    for (const id of upstreamOnly) console.log(`  + ${id}`);
    console.log(`\nlocal-only (${localOnly.length}) — never deleted by this script:`);
    for (const id of localOnly) console.log(`  ? ${id}`);
    console.log(`\nchanged (${changed.length}):`);
    for (const id of changed) console.log(`  ~ ${id}`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const varKeys = readVarKeys();

  for (const id of [...upstreamOnly, ...changed]) {
    const term = upstreamTerms.get(id);
    writeTermFile(id, term, convertBody(term.body, { varKeys, label: `${id}.mdx` }));
  }

  console.log(
    `migrate-glossary: added ${upstreamOnly.length}, updated ${changed.length}, left ${localOnly.length} local-only term(s) untouched (source: ${path.relative(repoRoot, srcDir)}).`,
  );
  if (localOnly.length) {
    console.log('local-only terms (present here, absent upstream — not deleted):');
    for (const id of localOnly) console.log(`  - ${id}`);
  }
}

// Only run when invoked directly (`node scripts/migrate-glossary.mjs`), not when imported by tests.
// `pathToFileURL` rather than a `file://` template: a path needing percent-encoding (a space being
// the common case) would never match the template, and the script would silently do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
