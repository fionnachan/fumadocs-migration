/**
 * nav — detect meta.json navigation defects.
 *
 * Fumadocs treats `pages` as an allowlist: when present, on-disk siblings that are not listed are
 * excluded from the sidebar unless the `"..."` rest operator appears. Entries naming a page that does
 * not exist are silently ignored. Both failure modes are invisible at build time, so we check them here.
 *
 * It also reads the editorial navigation manifest, `lib/docs-navigation.json`: `checkSections`
 * below compares its `sourceFolders` arrays against the content tree, and `duplicateManifestPages`
 * reports a page URL claimed twice. That second rule lives in `lib/docs-navigation-rules.mjs` so
 * the gate and the transformer apply the same copy of it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Read the sections out of the navigation manifest.
 *
 * Separate from the `meta.json` checks below because it reads a different file: `meta.json` still
 * describes the content folders, while the manifest arranges those pages into the editorial
 * hierarchy the sidebar actually renders. Two rules need it, `duplicateManifestPages` (in
 * `lib/docs-navigation-rules.mjs`, shared with the transformer) and `checkSections`, so the gate
 * reads the file once and hands the same array to both.
 */
export function readSections(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8')).sections;
}

/**
 * Fumadocs' own link-entry regex, copied verbatim from
 * `node_modules/fumadocs-core/dist/dynamic-lx_V4971.js:261` (fumadocs-core 16.15.9) so that the two
 * cannot drift. Three forms build a link node, not one: `[Name](/url)`, `[Icon][Name](/url)` and
 * `external:[Name](/url)`. `resolveLink` turns every match into a `type: "page"` node carrying the
 * literal `url` (the `external` group sets a flag and leaves `url` untouched), so all three shadow
 * a real page in exactly the same way. Recognising only the first left this gate with a hole shaped
 * like the bug it exists to catch.
 */
const LINK_ENTRY =
  /^(?<external>external:)?(?:\[(?<icon>[^\]]+)])?\[(?<name>[^\]]+)]\((?<url>[^)]+)\)$/;

/** Classify a single `pages` entry. */
export function classifyEntry(entry) {
  if (typeof entry !== 'string') return { kind: 'unknown', name: String(entry) };
  if (entry === '...' || entry === 'z...a') return { kind: 'rest', name: entry };
  // `startsWith('[')` stays as a catch-all so a malformed bracket entry is still reported as a
  // link rather than as a missing page; LINK_ENTRY adds the `external:` form, which starts with a
  // letter and would otherwise be read as a page name.
  if (entry.startsWith('[') || LINK_ENTRY.test(entry)) return { kind: 'link', name: entry };
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
 * Section coverage: the second navigation defect this module detects.
 *
 * Since PR #73 the rendered sidebar is built by `lib/docs-navigation.ts` from the manifest, and
 * what decides whether a page lands inside a section is that section's `sourceFolders` array. The
 * transformer places every explicitly claimed page, then sweeps each section's source folders for
 * leftovers and appends them to that section under "Additional guides". A page no source folder
 * reaches is still emitted, but beside the sections rather than inside one, so it renders above
 * them with no section sidebar of its own. That is invisible to `types:check` and to `build`
 * (FS-2751).
 *
 * The `"root": true` flags this rule used to read are gone. They decided nothing a reader saw: the
 * transformer overwrites `root` on every folder node it emits, so deleting all twelve left the
 * rendered tree structurally identical. See INTERNALS, "The sidebar and its roots".
 *
 * Three things can leave a page outside every section:
 *
 * 1. Its top-level directory is named in no section's `sourceFolders`.
 * 2. It is a loose page at the top of `content/docs` that no directory's `pages` array claims.
 *    `content/docs/resources/meta.json` is what claims the four that exist today, through
 *    `"../chain-info"`-style references.
 * 3. A `pages` link entry elsewhere points at the page's own URL. A link entry becomes a real page
 *    node in the content tree, so the transformer indexes it by URL alongside the real node and can
 *    both rename the page and pull it into the linking directory's section. Every root folder used
 *    to carry `"[Chain info](/docs/chain-info)"`, which is how `/docs/chain-info` came to be
 *    labelled "Third-party docs" (FS-2716). Measured again under the manifest: the same shape still
 *    moves a page between sections and still overwrites its label.
 */

/** The docs landing page belongs to no section by design: its sidebar is the section list itself. */
export const SECTIONLESS_BY_DESIGN = ['index'];

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

/** The top-level directory a docs-relative path sits under (`''` for the docs root itself). */
function topLevelOf(p) {
  const i = p.indexOf('/');
  return i === -1 ? p : p.slice(0, i);
}

/**
 * Compare the manifest's `sourceFolders` against the content tree, and find shadowing link entries.
 *
 * Takes the tree as plain data so it can be unit-tested without a filesystem:
 * - `dirs`: docs-relative directory path (`''` is `content/docs`) to its parsed meta.json, or
 *   `undefined` where the directory has none.
 * - `pages`: docs-relative page paths with no extension (`'chain-info'`, `'get-started/index'`).
 * - `sections`: the manifest sections, as read by `readSections`.
 *
 * Ownership mirrors `buildFolder` in fumadocs-core: an explicit `pages` entry claims a page or a
 * folder for the directory that lists it (the first claim wins, as in `own()`), and anything
 * unclaimed belongs to the directory it sits in. A directory is covered when that chain of claims
 * reaches a directory some section names in `sourceFolders`, which is exactly the set of folders
 * `buildDocsNavigation` sweeps for leftovers.
 *
 * Returns, in the order a report should read them:
 * - `missingFolders`: a `sourceFolders` entry that will not resolve to a folder node. The
 *   transformer throws on this, so it is a broken dev server rather than a wrong sidebar, but the
 *   gate names the section and the entry instead of leaving a stack trace to read. It tests for what
 *   the transformer needs rather than for a directory on disk, because fumadocs-core's `buildFolder`
 *   returns nothing when `storage.readDir` finds no file, and that storage holds only `.mdx` and
 *   `meta.json`. Measured: a `content/docs/empty-zone/` holding one `.txt` and named in a
 *   `sourceFolders` array passed the disk test while `pnpm dev` threw
 *   `Navigation source folder does not exist: empty-zone`.
 * - `sharedFolders`: a folder named more than once across the sections' `sourceFolders` arrays,
 *   whether by two sections or twice by one. Sections are swept in manifest order and the first
 *   listing takes every leftover, so the later one does nothing.
 * - `uncoveredFolders`: a top-level directory no section covers.
 * - `unsectioned`: a page no section covers, skipping pages whose top-level directory is already in
 *   `uncoveredFolders` so that one root cause produces one message. In practice what is left is a
 *   loose page at the top of `content/docs` that no directory claims.
 * - `shadowLinks`: a `pages` link entry pointing at a real page in this repo.
 */
export function checkSections({ dirs, pages, sections, exempt = SECTIONLESS_BY_DESIGN }) {
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

  // What `buildDocsNavigation` looks up is a folder node, which fumadocs-core builds only for a
  // directory whose storage holds at least one file, and that storage holds only `.mdx` pages and
  // `meta.json`. A directory of images, or one left empty mid-edit, has neither and gets no node.
  const hasFolderNode = (dir) => {
    if (!dirs.has(dir)) return false;
    if (dirs.get(dir) !== undefined) return true;
    const prefix = `${dir}/`;
    for (const page of pages) if (page.startsWith(prefix)) return true;
    for (const [other, meta] of dirs)
      if (meta !== undefined && other.startsWith(prefix)) return true;
    return false;
  };

  const claims = new Map();
  const missingFolders = [];
  for (const section of sections ?? []) {
    for (const folder of section.sourceFolders ?? []) {
      if (!hasFolderNode(folder)) missingFolders.push({ section: section.id, folder });
      claims.set(folder, [...(claims.get(folder) ?? []), section.id]);
    }
  }
  const sharedFolders = [...claims]
    .filter(([, ids]) => ids.length > 1)
    .map(([folder, ids]) => ({ folder, sections: [...new Set(ids)], count: ids.length }));

  const covered = new Map();
  const isCovered = (dir, seen = new Set()) => {
    if (covered.has(dir)) return covered.get(dir);
    if (seen.has(dir)) return false;
    seen.add(dir);
    let value;
    if (claims.has(dir)) value = true;
    else if (dir === '') value = false;
    else value = isCovered(folderOwner.get(dir) ?? parentOf(dir), seen);
    covered.set(dir, value);
    return value;
  };

  const uncoveredFolders = [...dirs.keys()]
    .filter((dir) => dir !== '' && !dir.includes('/') && !isCovered(dir))
    .sort();

  const reported = new Set(uncoveredFolders);
  const exemptSet = new Set(exempt);
  const unsectioned = [];
  for (const page of pages) {
    if (exemptSet.has(page)) continue;
    const owner = pageOwner.get(page) ?? parentOf(page);
    if (!isCovered(owner) && !reported.has(topLevelOf(owner))) unsectioned.push(page);
  }

  return {
    missingFolders,
    sharedFolders,
    uncoveredFolders,
    unsectioned: unsectioned.sort(),
    shadowLinks,
  };
}

/** The docs-relative page path a link entry points at, or `null` for anything else. */
function linkTarget(entry) {
  const url = LINK_ENTRY.exec(entry)?.groups?.url;
  if (!url || !url.startsWith('/docs/')) return null;
  return url.slice('/docs/'.length).split(/[#?]/)[0].replace(/\/$/, '');
}

/** Read a content tree into the plain `{ dirs, pages }` shape `checkSections` takes. */
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
