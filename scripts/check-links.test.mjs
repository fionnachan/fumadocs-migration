import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { extractRefs, resolvesToPublicAsset } from './lib/doc-links.mjs';

test('link extraction preserves source ranges after Unicode frontmatter and prose', () => {
  const source =
    '---\ntitle: "🦀 [not a link](./metadata)"\n---\n\n' +
    '🦀 [first](./first) and [second](./second).';
  const refs = extractRefs(source);
  assert.deepEqual(
    refs.map((ref) => ref.rawUrl),
    ['./first', './second'],
  );
  for (const ref of refs) {
    assert.equal(source.slice(...ref.range), ref.rawUrl);
  }
});

test('link extraction ignores nested fences and multi-backtick code spans', () => {
  const source = [
    '````markdown',
    '```rust',
    '```',
    '[fenced](./fenced)',
    '````',
    '',
    '``a `backtick` and [inline](./inline)``',
    '',
    '``a multiline',
    '[multiline](./multiline) span``',
    '',
    '[prose](./prose)',
  ].join('\n');
  assert.deepEqual(
    extractRefs(source).map((ref) => ref.rawUrl),
    ['./prose'],
  );
});

/** A throwaway repo root with a `public/` tree, so these tests never depend on repo state. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-links-public-'));
  mkdirSync(path.join(root, 'public', 'audit-reports'), { recursive: true });
  writeFileSync(path.join(root, 'public', 'audit-reports', 'report.pdf'), '%PDF-1.4');
  writeFileSync(path.join(root, 'public', 'nitro-whitepaper.pdf'), '%PDF-1.4');
  writeFileSync(path.join(root, 'outside.txt'), 'not under public/');
  return root;
}

test('a root-absolute path resolves to an existing file under public/', () => {
  const root = fixture();
  assert.equal(resolvesToPublicAsset('/audit-reports/report.pdf', root), true);
  assert.equal(resolvesToPublicAsset('/nitro-whitepaper.pdf', root), true);
});

test('a root-absolute path with no matching file does not resolve', () => {
  const root = fixture();
  assert.equal(resolvesToPublicAsset('/audit-reports/does-not-exist.pdf', root), false);
});

test('a relative path never resolves to public/', () => {
  const root = fixture();
  // Relative links resolve against the page's own URL inside the docs route tree, not against the
  // static root — so `audit-reports/report.pdf` written on /docs/audit-reports is a genuine 404 and
  // must keep being reported.
  assert.equal(resolvesToPublicAsset('audit-reports/report.pdf', root), false);
  assert.equal(resolvesToPublicAsset('./audit-reports/report.pdf', root), false);
});

test('traversal cannot escape public/', () => {
  const root = fixture();
  assert.equal(resolvesToPublicAsset('/../outside.txt', root), false);
  assert.equal(resolvesToPublicAsset('/audit-reports/../../outside.txt', root), false);
});

test('a directory is not a servable asset', () => {
  const root = fixture();
  assert.equal(resolvesToPublicAsset('/audit-reports', root), false);
});
