/**
 * Offline tripwire over `redirects.config.mjs`, the one redirect file.
 *
 * `pnpm redirects:check` is the authoritative check (it asks the running router), but it needs a
 * server and runs only in the `Build` job. This walks `content/docs` instead, so a hand edit that
 * points a legacy URL at a page that does not exist, or a page leaving the tree some other way,
 * fails `pnpm test` without one. A destination is checked case-sensitively: Next routes are, and a
 * redirect to the wrong case still 404s.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { redirects } from '../../redirects.config.mjs';
import { buildIndex } from './doc-links.mjs';
import { retargetDestinations } from './redirects-config.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isExternal = (value) => /^https?:\/\//.test(value);
const pageOf = (destination) => destination.split('#')[0];

test('every internal redirect destination names a page under content/docs', () => {
  const { byUrl } = buildIndex(repoRoot);
  const dead = redirects
    .filter((r) => !isExternal(r.destination) && !byUrl.has(pageOf(r.destination)))
    .map((r) => `${r.source} -> ${r.destination}`);
  assert.deepEqual(dead, []);
});

test('no redirect source is listed twice', () => {
  const seen = new Set();
  const dupes = redirects.map((r) => r.source).filter((s) => seen.size === seen.add(s).size);
  assert.deepEqual(dupes, []);
});

test('retargetDestinations rewrites destinations only, carries anchors, and matches whole URLs', () => {
  const src = [
    "  { source: '/docs/a/old', destination: '/docs/a/new', permanent: true },",
    "  { source: '/legacy/x', destination: '/docs/a/old', permanent: false },",
    '  {',
    "    source: '/legacy/y',",
    "    destination: '/docs/a/old#section',",
    '    permanent: false,',
    '  },',
    "  { source: '/legacy/z', destination: '/docs/a/old/child', permanent: false },",
  ].join('\n');
  const { source, changed } = retargetDestinations(src, '/docs/a/old', '/docs/b/moved');
  assert.equal(changed, 2);
  assert.match(source, /source: '\/legacy\/x', destination: '\/docs\/b\/moved'/);
  assert.match(source, /destination: '\/docs\/b\/moved#section'/);
  assert.match(source, /destination: '\/docs\/a\/old\/child'/, 'a child page is not a match');
  assert.match(
    source,
    /source: '\/docs\/a\/old', destination: '\/docs\/a\/new'/,
    'sources untouched',
  );
});

test('retargetDestinations is a no-op when nothing names the page', () => {
  const src = "  { source: '/legacy/x', destination: '/docs/other', permanent: false },";
  assert.deepEqual(retargetDestinations(src, '/docs/a/old', '/docs/b/new'), {
    source: src,
    changed: 0,
  });
});
