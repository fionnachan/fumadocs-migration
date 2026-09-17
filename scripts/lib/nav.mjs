/**
 * nav — detect meta.json navigation defects.
 *
 * Fumadocs treats `pages` as an allowlist: when present, on-disk siblings that are not listed are
 * excluded from the sidebar unless the `"..."` rest operator appears. Entries naming a page that does
 * not exist are silently ignored. Both failure modes are invisible at build time, so we check them here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Classify a single `pages` entry. */
export function classifyEntry(entry) {
  if (typeof entry !== 'string') return { kind: 'unknown', name: String(entry) };
  if (entry === '...' || entry === 'z...a') return { kind: 'rest', name: entry };
  if (entry.startsWith('[')) return { kind: 'link', name: entry };
  if (entry.startsWith('---')) return { kind: 'separator', name: entry };
  if (entry.startsWith('!')) return { kind: 'exclude', name: entry.slice(1) };
  return { kind: 'page', name: entry };
}

/** Compare one directory's meta.json against its on-disk entries. */
export function checkDir({ dir, meta, entries }) {
  const pages = Array.isArray(meta?.pages) ? meta.pages : null;
  if (!pages) return { dir, ghosts: [], hidden: [], hasRest: true };

  const classified = pages.map(classifyEntry);
  const hasRest = classified.some((c) => c.kind === 'rest');

  // `index.mdx` may legally be listed in `pages`, so it counts as on-disk for the ghost check —
  // but it is attached as the folder's own index regardless, so it can never be "hidden".
  const onDisk = new Set();
  const hideable = new Set();
  for (const e of entries) {
    if (e.isDir) {
      onDisk.add(e.name);
      hideable.add(e.name);
    } else if (e.name.endsWith('.mdx')) {
      const slug = e.name.replace(/\.mdx$/, '');
      onDisk.add(slug);
      if (e.name !== 'index.mdx') hideable.add(slug);
    }
  }

  const listed = new Set(
    classified.filter((c) => c.kind === 'page' || c.kind === 'exclude').map((c) => c.name),
  );

  const ghosts = [...listed].filter((name) => !onDisk.has(name) && !name.includes('/'));
  const hidden = hasRest ? [] : [...hideable].filter((name) => !listed.has(name));

  return { dir, ghosts: ghosts.sort(), hidden: hidden.sort(), hasRest };
}

/** Walk a content tree and check every directory that has a meta.json. */
export function checkTree(root) {
  const results = [];
  const walk = (abs) => {
    const entries = readdirSync(abs, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
    }));
    const metaPath = path.join(abs, 'meta.json');
    if (entries.some((e) => e.name === 'meta.json')) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const result = checkDir({ dir: abs, meta, entries });
      if (result.ghosts.length || result.hidden.length) results.push(result);
    }
    for (const e of entries) if (e.isDir) walk(path.join(abs, e.name));
  };
  walk(root);
  return results;
}

/**
 * Root coverage — the second navigation defect this module detects.
 *
 * Fumadocs decides which sidebar a page gets by walking the page tree to that page and taking the
 * last `"root": true` folder on the way (`path.findLast(...)` in `fumadocs-ui/contexts/tree`). A
 * page that sits outside every root folder has no such folder on its path, so it falls back to the
 * whole tree and the root switcher names nothing, or names whichever root happens to match last.
 * Both are invisible at build time, which is why they are checked here (FS-2716).
 *
 * Two things can put a page outside every root:
 *
 * 1. Nothing in its ancestry declares `"root": true`.
 * 2. A `pages` link entry elsewhere points at the page's own URL. A link entry becomes a real page
 *    node in the tree, so the depth-first search that resolves the page's path finds that copy
 *    first and hands the page the linking folder's sidebar. Every root folder used to carry
 *    `"[Chain info](/docs/chain-info)"`, which is exactly how `/docs/chain-info` came to be
 *    labelled "Third-party docs".
 */

/** The docs landing page belongs to no section by design: its sidebar is the section list itself. */
export const ROOTLESS_BY_DESIGN = ['index'];

/** Resolve a `pages` reference against the directory holding the meta.json, Fumadocs-style. */
export function resolveRef(dir, name) {
  const out = [];
  for (const seg of `${dir}/${name}`.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '' && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

/** The docs-relative directory a docs-relative page path sits in (`''` for the docs root). */
function parentOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * Find pages that no `"root": true` folder owns, and link entries that shadow a real page.
 *
 * Takes the tree as plain data so it can be unit-tested without a filesystem:
 * - `dirs`: docs-relative directory path (`''` is `content/docs`) to its parsed meta.json, or
 *   `undefined` where the directory has none.
 * - `pages`: docs-relative page paths with no extension (`'chain-info'`, `'get-started/index'`).
 *
 * Ownership mirrors `buildFolder` in fumadocs-core: an explicit `pages` entry claims a page or a
 * folder for the directory that lists it (the first claim wins, as in `own()`), and anything
 * unclaimed belongs to the directory it sits in.
 */
export function checkRoots({ dirs, pages, exempt = ROOTLESS_BY_DESIGN }) {
  const pageOwner = new Map();
  const folderOwner = new Map();
  const shadowLinks = [];

  for (const [dir, meta] of dirs) {
    if (!Array.isArray(meta?.pages)) continue;
    for (const entry of meta.pages) {
      const { kind, name } = classifyEntry(entry);
      if (kind === 'link') {
        const target = linkTarget(name);
        const shadowed = target && (pages.has(target) ? target : null);
        const viaIndex =
          target && !shadowed && pages.has(`${target}/index`) ? `${target}/index` : null;
        if (shadowed || viaIndex) shadowLinks.push({ dir, entry, page: shadowed ?? viaIndex });
        continue;
      }
      // `...name` extracts a folder's children into this one; it claims no page of its own.
      if (kind !== 'page' || name.startsWith('...')) continue;
      const target = resolveRef(dir, name);
      if (pages.has(target)) {
        if (!pageOwner.has(target)) pageOwner.set(target, dir);
      } else if (dirs.has(target) && !folderOwner.has(target)) {
        folderOwner.set(target, dir);
      }
    }
  }

  const covered = new Map();
  const isCovered = (dir, seen = new Set()) => {
    if (covered.has(dir)) return covered.get(dir);
    if (seen.has(dir)) return false;
    seen.add(dir);
    let value;
    if (dirs.get(dir)?.root === true) value = true;
    else if (dir === '') value = false;
    else value = isCovered(folderOwner.get(dir) ?? parentOf(dir), seen);
    covered.set(dir, value);
    return value;
  };

  const exemptSet = new Set(exempt);
  const rootless = [];
  for (const page of pages) {
    if (exemptSet.has(page)) continue;
    const owner = pageOwner.get(page) ?? parentOf(page);
    if (!isCovered(owner)) rootless.push(page);
  }

  return { rootless: rootless.sort(), shadowLinks };
}

/** The docs-relative page path a `[Title](/docs/…)` entry points at, or `null` for anything else. */
function linkTarget(entry) {
  const url = /^\[[^\]]*]\(([^)]*)\)$/.exec(entry)?.[1];
  if (!url || !url.startsWith('/docs/')) return null;
  return url.slice('/docs/'.length).split(/[#?]/)[0].replace(/\/$/, '');
}

/** Read a content tree into the plain `{ dirs, pages }` shape `checkRoots` takes. */
export function readTree(root) {
  const dirs = new Map();
  const pages = new Set();
  const walk = (abs, rel) => {
    const entries = readdirSync(abs, { withFileTypes: true });
    const metaPath = path.join(abs, 'meta.json');
    dirs.set(
      rel,
      entries.some((e) => e.name === 'meta.json')
        ? JSON.parse(readFileSync(metaPath, 'utf8'))
        : undefined,
    );
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name);
      else if (e.name.endsWith('.mdx')) {
        const slug = e.name.replace(/\.mdx$/, '');
        pages.add(rel ? `${rel}/${slug}` : slug);
      }
    }
  };
  walk(root, '');
  return { dirs, pages };
}
