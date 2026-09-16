/**
 * Text-parse of the partial-versioning registry (`VERSIONED` in `lib/versions-constants.ts`).
 *
 * Parsing rather than importing, because no plain node script can resolve the `@/` alias or read
 * TypeScript — the same wall `redirects-check.mjs` hits from the other side, which is why that one
 * reads `/llms.txt` off a running server. The registry was moved out of `lib/versions.ts` by
 * FS-2698 precisely so that `proxy.ts` could import it without dragging in `collections/server`;
 * this module follows it.
 *
 * Two consumers: `scripts/versioned-docs-check.mjs` (the build-time advisory) and
 * `scripts/versions-routing.test.mjs` (the routing invariants).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Keep in sync with lib/versions-constants.ts. */
export const VERSIONS_FILE = 'lib/versions-constants.ts';
/** Keep in sync with `ARCHIVE_ROOT` in lib/versions.ts. */
export const ARCHIVE_ROOT = 'content/_versions';
/** Keep in sync with the `docs` collection `dir` in source.config.ts. */
export const DOCS_ROOT = 'content/docs';

/**
 * Every versioned page in the registry: `{ slug, archives: [{ id, archivePath }] }`, in file order.
 * `archives` excludes the `latest` entry, which has no `archivePath` and is the live page itself.
 *
 * Returns `[]` when the literal cannot be found, which is what the advisory wants (warn about
 * nothing) and what the test asserts against (an empty registry is itself a failure there).
 */
export function parseVersionedRegistry(repoRoot) {
  const src = readFileSync(path.join(repoRoot, VERSIONS_FILE), 'utf8');
  const objStart = src.indexOf('const VERSIONED');
  if (objStart === -1) return [];

  const body = src.slice(objStart);
  const entries = [];
  // Each entry looks like:  'slug/here': [ { id: 'latest' }, { id: 'v1', archivePath: '...' } ],
  const entryRe = /'([^']+)':\s*\[([\s\S]*?)\]/g;
  // `[^{}]` rather than `.` so the fields may sit on separate lines, but the match still cannot
  // run past the end of one object literal.
  const archiveRe = /\{[^{}]*id:\s*'([^']+)'[^{}]*archivePath:\s*'([^']+)'[^{}]*\}/g;

  let entry;
  while ((entry = entryRe.exec(body)) !== null) {
    const archives = [...entry[2].matchAll(archiveRe)].map(([, id, archivePath]) => ({
      id,
      archivePath,
    }));
    entries.push({ slug: entry[1], archives });
  }
  return entries;
}

/**
 * Repo-relative paths of every document the registry pins: each archive file plus the live page it
 * archives. Live pages are `content/docs/<slug>.mdx`; a slug served by a directory index resolves
 * to `content/docs/<slug>/index.mdx`, so callers that need the file on disk should accept either.
 */
export function pinnedDocuments(repoRoot) {
  const docs = new Set();
  for (const { slug, archives } of parseVersionedRegistry(repoRoot)) {
    for (const { archivePath } of archives) {
      docs.add(path.posix.join(ARCHIVE_ROOT, archivePath));
      docs.add(path.posix.join(DOCS_ROOT, `${slug}.mdx`));
    }
  }
  return [...docs];
}
