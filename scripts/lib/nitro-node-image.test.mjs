import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { rewriteImage, syncImageInContent } from './nitro-node-image.mjs';

const OLD = 'offchainlabs/nitro-node:v3.11.3-beb2108';
const NEW = 'offchainlabs/nitro-node:v3.12.0-abc1234';

test('rewriteImage replaces every occurrence and counts them', () => {
  const src = `docker run ${OLD} keygen\n\nimage: ${OLD}\n`;
  const { text, count } = rewriteImage(src, OLD, NEW);
  assert.equal(count, 2);
  assert.ok(!text.includes(OLD));
  assert.equal(text.split(NEW).length - 1, 2);
});

test('rewriteImage leaves an older pinned tag alone', () => {
  const src = 'image: offchainlabs/nitro-node:v3.9.9-6b0af88\n';
  assert.deepEqual(rewriteImage(src, OLD, NEW), { text: src, count: 0 });
});

test('rewriteImage is a no-op when the value did not move', () => {
  const src = `docker run ${OLD} keygen\n`;
  assert.deepEqual(rewriteImage(src, OLD, OLD), { text: src, count: 0 });
  assert.deepEqual(rewriteImage(src, undefined, NEW), { text: src, count: 0 });
});

test('syncImageInContent rewrites mdx across the tree and reports what changed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nitro-image-'));
  mkdirSync(path.join(root, 'content', 'docs', 'nested'), { recursive: true });

  const hit = path.join(root, 'content', 'docs', 'a.mdx');
  const nested = path.join(root, 'content', 'docs', 'nested', 'b.mdx');
  const miss = path.join(root, 'content', 'docs', 'c.mdx');
  writeFileSync(hit, `\`\`\`shell\ndocker run ${OLD} keygen\n\`\`\`\n`);
  writeFileSync(nested, `Runs on ${OLD}, twice: ${OLD}.\n`);
  writeFileSync(miss, 'image: offchainlabs/nitro-node:v3.9.9-6b0af88\n');

  const changed = syncImageInContent(root, OLD, NEW);

  assert.deepEqual(changed.map((c) => c.rel).sort(), [
    'content/docs/a.mdx',
    'content/docs/nested/b.mdx',
  ]);
  assert.equal(changed.find((c) => c.rel.endsWith('b.mdx')).count, 2);
  assert.ok(readFileSync(hit, 'utf8').includes(NEW));
  assert.ok(readFileSync(nested, 'utf8').includes(NEW));
  assert.equal(readFileSync(miss, 'utf8'), 'image: offchainlabs/nitro-node:v3.9.9-6b0af88\n');
});

test('syncImageInContent with write:false reports without touching disk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nitro-image-'));
  mkdirSync(path.join(root, 'content'), { recursive: true });
  const file = path.join(root, 'content', 'a.mdx');
  const before = `docker run ${OLD} keygen\n`;
  writeFileSync(file, before);

  const changed = syncImageInContent(root, OLD, NEW, { write: false });

  assert.deepEqual(changed, [{ rel: 'content/a.mdx', count: 1 }]);
  assert.equal(readFileSync(file, 'utf8'), before);
});
