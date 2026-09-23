/**
 * Tripwires over the hand-maintained legacy redirect overlay.
 *
 * Extracted from `scripts/generate-legacy-redirects.test.mjs` when the generator was deleted
 * (FS-2706). Everything that tested the generator went with it; these did not, because they pin the
 * shipped maps against the real content tree rather than any derivation from upstream.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MANUAL_DESTINATIONS,
  SECTION_LANDINGS,
  UPSTREAM_TITLES,
  collectPagesByTitle,
  collectValidUrls,
  isAbsolute,
  resolveUrl,
} from './legacy-redirects.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contentDir = path.join(repoRoot, 'content/docs');

/** Both hand-written destination maps, named, in the order their entries are reported. */
const MAPS = [
  ['MANUAL_DESTINATIONS', MANUAL_DESTINATIONS],
  ['SECTION_LANDINGS', SECTION_LANDINGS],
];

test('every SECTION_LANDINGS value names a page under /docs', () => {
  for (const [source, landing] of SECTION_LANDINGS) {
    assert.ok(landing.startsWith('/docs/'), `${source} -> ${landing}`);
  }
});

/**
 * The two hand-written destination maps, pinned against the real content tree.
 *
 * An entry orphaned by `pnpm move-doc` would otherwise rot silently into a redirect to a 404, and
 * `redirects:check` is the only other thing that would catch it, which needs a live site. This is
 * the same guard the repo requires of every hand-written list, for the same reason: growing one
 * should be a reviewed act, and an entry that rots should fail the suite.
 *
 * Since the generator was deleted this is the only automated check on either map that runs without
 * a server, which makes it the reason `move-doc` retargets them in the first place.
 */
test('every hand-written destination still names a live page in the content tree', () => {
  const valid = collectValidUrls(contentDir);
  const missing = [];
  for (const [name, map] of MAPS) {
    for (const [source, destination] of map) {
      if (isAbsolute(destination)) continue;
      // A destination may carry an anchor; only the page part has to resolve.
      const [page] = destination.split('#');
      if (!resolveUrl(valid, page)) missing.push(`${name}: ${source} -> ${destination}`);
    }
  }
  assert.deepEqual(missing, []);
});

/**
 * Every title recorded in `UPSTREAM_TITLES` belongs to an entry that is still there.
 *
 * The title map is keyed by legacy source, so retargeting an entry keeps the two in step
 * automatically, but deleting one does not. A leftover title is worse than no title: the rule below
 * would keep asserting something about a redirect nobody serves any more, and the day a page
 * happened to take that title it would fail the suite naming a source that does not exist.
 */
test('every UPSTREAM_TITLES key is still an entry in one of the two maps', () => {
  const known = new Set(MAPS.flatMap(([, map]) => [...map.keys()]));
  const orphans = [...UPSTREAM_TITLES.keys()].filter((source) => !known.has(source));
  assert.deepEqual(orphans, []);
});

/**
 * Rule 4 of the resolution order, enforced continuously rather than once at generation time.
 *
 * When exactly one page here carries the upstream page's frontmatter title verbatim, that page is
 * where the legacy URL has to go. The generator applied that rule once, at generation time, and
 * nothing re-applied it: nine entries were committed pointing at a section landing while the page
 * was already in the same tree, so a reader asking for "Common error messages" was answered with a
 * list of links to the Operate section. `redirects:check` cannot see it either, because it only
 * asks whether a destination exists, and a section landing exists.
 *
 * The rule is deliberately conditional in both directions. A title no page carries proves nothing
 * and is skipped, which is the state of the two entries still in `SECTION_LANDINGS`: port either
 * page and this test starts failing until its entry is retargeted, which is the whole point. A
 * title two pages share is skipped as well, for the same reason rule 4 declines there: the title no
 * longer identifies one page, so it cannot say which one is right.
 *
 * It checks the destination's page part only, since a destination may carry an `#anchor`, and it
 * compares URLs exactly rather than case-insensitively, because these are destinations this repo
 * writes about its own pages, not the mixed-case legacy corpus `resolveUrl` exists for.
 */
test('a destination names the page carrying the upstream title, when exactly one page does', () => {
  const byTitle = collectPagesByTitle(contentDir);
  const wrong = [];
  for (const [name, map] of MAPS) {
    for (const [source, destination] of map) {
      const title = UPSTREAM_TITLES.get(source);
      if (!title) continue;
      const pages = byTitle.get(title) ?? [];
      if (pages.length !== 1) continue;
      const [page] = destination.split('#');
      if (page !== pages[0]) {
        wrong.push(
          `${name}: ${source} -> ${destination}, but "${title}" is now ${pages[0]}. Retarget the ` +
            `entry and its twin in redirects.legacy.mjs.`,
        );
      }
    }
  }
  assert.deepEqual(wrong, []);
});
