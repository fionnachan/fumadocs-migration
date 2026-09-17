/**
 * Tripwires over the hand-maintained legacy redirect overlay.
 *
 * Extracted from `scripts/generate-legacy-redirects.test.mjs` when the generator was deleted
 * (FS-2706). Everything that tested the generator went with it; these two tests did not, because
 * they pin the shipped maps against the real content tree rather than any derivation from upstream.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MANUAL_DESTINATIONS,
  SECTION_LANDINGS,
  collectValidUrls,
  isAbsolute,
  resolveUrl,
} from './legacy-redirects.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  const valid = collectValidUrls(path.join(repoRoot, 'content/docs'));
  const missing = [];
  for (const [name, map] of [
    ['MANUAL_DESTINATIONS', MANUAL_DESTINATIONS],
    ['SECTION_LANDINGS', SECTION_LANDINGS],
  ]) {
    for (const [source, destination] of map) {
      if (isAbsolute(destination)) continue;
      // A destination may carry an anchor; only the page part has to resolve.
      const [page] = destination.split('#');
      if (!resolveUrl(valid, page)) missing.push(`${name}: ${source} -> ${destination}`);
    }
  }
  assert.deepEqual(missing, []);
});
