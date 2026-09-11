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
 * Upstream path resolution (first that resolves), mirroring the order documented in
 * scripts/data/upstream.config.json:
 *   1. --upstream <path>          (path to the upstream repo root, e.g. ../arbitrum-docs)
 *   2. UPSTREAM_DOCS_REPO env var (same)
 *   3. `repo` in scripts/data/upstream.config.json
 *   4. `probePaths` in the same file, first one that exists
 * The glossary source dir is <repo>/<docsSubdir>/partials/glossary.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const outDir = path.join(repoRoot, 'content', 'glossary');
const varsPath = path.join(repoRoot, 'content', 'vars.json');
const upstreamConfigPath = path.join(repoRoot, 'scripts', 'data', 'upstream.config.json');

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

/** Resolve the upstream repo root: --upstream flag, env var, config `repo`, then `probePaths`. */
export function resolveUpstreamRepo(argv, { env = process.env, cwd = repoRoot } = {}) {
  const idx = argv.indexOf('--upstream');
  if (idx !== -1 && argv[idx + 1]) return path.resolve(cwd, argv[idx + 1]);
  if (env.UPSTREAM_DOCS_REPO) return path.resolve(cwd, env.UPSTREAM_DOCS_REPO);

  let config = {};
  try {
    config = JSON.parse(readFileSync(upstreamConfigPath, 'utf8'));
  } catch {
    // No config file — fall through to null; caller reports the failure.
  }
  const candidates = [config.repo, ...(config.probePaths ?? [])].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(cwd, candidate.replace(/^~/, env.HOME ?? '~'));
    if (existsSync(resolved)) return resolved;
  }
  return null;
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
 */
export function normalizeForComparison(body) {
  return body
    .replace(/<a[^>]*data-quicklook-from=(["']).*?\1[^>]*>([\s\S]*?)<\/a>/g, '$2')
    .replace(/<Term[^>]*>([\s\S]*?)<\/Term>/g, '$1')
    .replace(/<a[^>]*href=(["']).*?\1[^>]*>([\s\S]*?)<\/a>/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/@@[a-zA-Z0-9_.]+@@/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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
 *   - an absolute link ending in `.mdx` that isn't already `/docs/...` is rewritten to
 *     `/docs/<path>` (extension dropped) when that page exists locally; otherwise left as-is and
 *     reported, since guessing a renamed section would risk a silently wrong link
 *   - `@@key@@` is left untouched unless `key` exists in content/vars.json, per the ticket's
 *     instruction not to introduce a `<Var>` for a var that doesn't exist here
 */
export function convertBody(
  body,
  {
    varKeys = readVarKeys(),
    docsRoot = path.join(repoRoot, 'content', 'docs'),
    warn = console.warn,
  } = {},
) {
  let out = body
    .replace(/\/intro\/glossary/g, '/docs/glossary')
    .replace(
      /<a\s+data-quicklook-from=(["'])([^"']+)\1\s*>([\s\S]*?)<\/a>/g,
      '<Term id="$2">$3</Term>',
    );

  out = out.replace(/\]\((\/[^)]+?\.mdx)\)/g, (match, mdxPath) => {
    const rel = mdxPath.replace(/^\//, '');
    if (!existsSync(path.join(docsRoot, rel))) {
      warn(
        `migrate-glossary: link target ${mdxPath} not found under content/docs/ — left unconverted.`,
      );
      return match;
    }
    const withoutExt = mdxPath.replace(/\.mdx$/, '');
    return `](/docs${withoutExt})`;
  });

  out = out.replace(/@@([a-zA-Z0-9_.]+)@@/g, (match, key) => {
    if (varKeys.has(key)) return `<Var name="${key}" />`;
    warn(
      `migrate-glossary: "@@${key}@@" has no matching key in content/vars.json — left unconverted.`,
    );
    return match;
  });

  return out;
}

/** Compute the three comparison sets between upstream and local term maps. */
export function computeSets(upstreamTerms, localTerms) {
  const upstreamIds = new Set(upstreamTerms.keys());
  const localIds = new Set(localTerms.keys());
  const upstreamOnly = [...upstreamIds].filter((id) => !localIds.has(id)).sort();
  const localOnly = [...localIds].filter((id) => !upstreamIds.has(id)).sort();
  const changed = [...upstreamIds]
    .filter((id) => localIds.has(id))
    .filter(
      (id) =>
        normalizeForComparison(upstreamTerms.get(id).body) !==
        normalizeForComparison(localTerms.get(id).body),
    )
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

  const upstreamRepo = resolveUpstreamRepo(argv);
  if (!upstreamRepo) {
    console.error(
      'migrate-glossary: could not resolve the upstream repo. Pass --upstream <path>, set UPSTREAM_DOCS_REPO, or add a sibling checkout (see scripts/data/upstream.config.json).',
    );
    process.exitCode = 1;
    return;
  }

  let docsSubdir = 'docs';
  try {
    docsSubdir = JSON.parse(readFileSync(upstreamConfigPath, 'utf8')).docsSubdir ?? docsSubdir;
  } catch {
    // use the default
  }
  const srcDir = path.join(upstreamRepo, docsSubdir, 'partials', 'glossary');
  if (!existsSync(srcDir)) {
    console.error(`migrate-glossary: no glossary partials found at ${srcDir}.`);
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

  for (const id of upstreamOnly) {
    const term = upstreamTerms.get(id);
    writeTermFile(id, term, convertBody(term.body, { varKeys }));
  }
  for (const id of changed) {
    const term = upstreamTerms.get(id);
    writeTermFile(id, term, convertBody(term.body, { varKeys }));
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
if (import.meta.url === `file://${process.argv[1]}`) main();
