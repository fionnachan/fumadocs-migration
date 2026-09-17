/**
 * Tripwire for `sidebarResourceLinks` in `lib/shared.ts`, the three cross-section links pinned in
 * the sidebar footer on every docs page (`components/sidebar-resource-links.tsx`).
 *
 * `lib/shared.ts` is imported as `.ts` directly: Node 22 strips types natively, and this module
 * imports only `./site-url.mjs` (plain JS), so it loads under `node --test` the same way
 * `lib/llms-tracking.ts` does for `llms-tracking.test.mjs`. That means this test exercises the
 * exact object the component renders, not a copy that can drift from it.
 *
 * Nothing else checks these three hrefs. `scripts/check-links.mjs` walks `content/docs/**`
 * `.md(x)` files only, by its own header comment, and `pnpm move-doc` retargets `redirects.config.mjs`
 * and the drift/legacy-destination maps but not a `.tsx` file. Without this test, deleting or
 * renaming one of the three pages would leave a silent 404 in the footer of every section sidebar.
 * Same ungated shape `announcementLinkHref` has, which is why `collectValidUrls`/`resolveUrl` (the
 * content-tree walk `legacy-redirects.test.mjs` pins its own hand-written maps against) is reused
 * here rather than writing a third copy of "map a /docs/... URL to a file".
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sidebarResourceLinks } from '../../lib/shared.ts';
import { collectValidUrls, resolveUrl } from './legacy-redirects.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every sidebar resource link resolves to a real page under content/docs', () => {
  const valid = collectValidUrls(path.join(repoRoot, 'content/docs'));
  const missing = sidebarResourceLinks
    .map((link) => link.url)
    .filter((url) => !resolveUrl(valid, url));
  assert.deepEqual(missing, []);
});

test('every sidebar resource link has a non-empty label', () => {
  for (const link of sidebarResourceLinks) {
    assert.equal(typeof link.text, 'string');
    assert.ok(link.text.trim().length > 0, `empty label for ${link.url}`);
  }
});
