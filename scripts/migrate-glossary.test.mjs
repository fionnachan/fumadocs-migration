import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  computeSets,
  convertBody,
  normalizeForComparison,
  parseFrontmatter,
  readLocalTerms,
  readUpstreamTerms,
  resolveUpstreamRepo,
  yamlQuote,
} from './migrate-glossary.mjs';

test('parseFrontmatter splits a leading --- block from the body', () => {
  const { data, body } = parseFrontmatter(
    '---\nkey: forwarder\ntitle: Forwarder\n---\n\nbody text\n',
  );
  assert.deepEqual(data, { key: 'forwarder', title: 'Forwarder' });
  assert.equal(body.trim(), 'body text');
});

test('parseFrontmatter strips quotes from quoted values', () => {
  const { data } = parseFrontmatter("---\ntitle: 'Quoted Title'\n---\nbody\n");
  assert.equal(data.title, 'Quoted Title');
});

test('parseFrontmatter tolerates a file with no frontmatter', () => {
  const { data, body } = parseFrontmatter('just a body, no frontmatter\n');
  assert.deepEqual(data, {});
  assert.equal(body, 'just a body, no frontmatter\n');
});

test('yamlQuote escapes embedded single quotes', () => {
  assert.equal(yamlQuote("Data's key"), "'Data''s key'");
});

test('normalizeForComparison treats a data-quicklook-from anchor and a <Term> as equal text', () => {
  const upstream = 'See <a data-quicklook-from="wasm">WASM</a> for details.';
  const local = 'See <Term id="wasm">WASM</Term> for details.';
  assert.equal(normalizeForComparison(upstream), normalizeForComparison(local));
});

test('normalizeForComparison treats an /intro/glossary link and a /docs/glossary link as equal', () => {
  const upstream = 'See [Layer 1](/intro/glossary#layer-1-l1).';
  const local = 'See [Layer 1](/docs/glossary#layer-1-l1).';
  assert.equal(normalizeForComparison(upstream), normalizeForComparison(local));
});

test('normalizeForComparison still detects a genuine wording change', () => {
  assert.notEqual(
    normalizeForComparison('Short definition.'),
    normalizeForComparison('A longer, different definition.'),
  );
});

test('convertBody rewrites /intro/glossary links to /docs/glossary', () => {
  const out = convertBody('See [Validator](/intro/glossary#validator).', {
    varKeys: new Set(),
    warn: () => {},
  });
  assert.equal(out, 'See [Validator](/docs/glossary#validator).');
});

test('convertBody rewrites a data-quicklook-from anchor to <Term>', () => {
  const out = convertBody('<a data-quicklook-from="wasm">WASM</a> bytecode.', {
    varKeys: new Set(),
    warn: () => {},
  });
  assert.equal(out, '<Term id="wasm">WASM</Term> bytecode.');
});

test('convertBody rewrites an existing .mdx doc link to a /docs path without the extension', () => {
  const dir = mktempDocsRoot();
  try {
    const out = convertBody(
      'See [chain params](/arbitrum-essentials/reference/chain-params.mdx).',
      {
        varKeys: new Set(),
        docsRoot: dir,
        warn: () => {},
      },
    );
    assert.equal(out, 'See [chain params](/docs/arbitrum-essentials/reference/chain-params).');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertBody leaves a .mdx link unconverted and warns when the target does not exist locally', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-glossary-docs-'));
  const warnings = [];
  try {
    const out = convertBody('See [nowhere](/does/not/exist.mdx).', {
      varKeys: new Set(),
      docsRoot: dir,
      warn: (msg) => warnings.push(msg),
    });
    assert.equal(out, 'See [nowhere](/does/not/exist.mdx).');
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertBody expands @@key@@ to <Var> only when the key exists in vars', () => {
  const known = convertBody('Runs @@nitroVersionTag@@.', {
    varKeys: new Set(['nitroVersionTag']),
    warn: () => {},
  });
  assert.equal(known, 'Runs <Var name="nitroVersionTag" />.');

  const warnings = [];
  const unknown = convertBody('Runs @@notARealVar@@.', {
    varKeys: new Set(),
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(unknown, 'Runs @@notARealVar@@.');
  assert.equal(warnings.length, 1);
});

test('computeSets partitions ids into upstream-only, local-only, and changed', () => {
  const upstream = new Map([
    ['a', { title: 'A', sortAs: 'A', body: 'same' }],
    ['b', { title: 'B', sortAs: 'B', body: 'new upstream text' }],
    ['c', { title: 'C', sortAs: 'C', body: 'only upstream' }],
  ]);
  const local = new Map([
    ['a', { title: 'A', sortAs: 'A', body: 'same' }],
    ['b', { title: 'B', sortAs: 'B', body: 'old local text' }],
    ['d', { title: 'D', sortAs: 'D', body: 'only local' }],
  ]);
  const { upstreamOnly, localOnly, changed } = computeSets(upstream, local);
  assert.deepEqual(upstreamOnly, ['c']);
  assert.deepEqual(localOnly, ['d']);
  assert.deepEqual(changed, ['b']);
});

test('readUpstreamTerms skips a partial with no `key` frontmatter and keeps only one of a duplicate key', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-glossary-upstream-'));
  try {
    writeFileSync(path.join(dir, '_a.mdx'), '---\ntitle: A\nkey: a\n---\nbody a\n');
    writeFileSync(path.join(dir, '_no-key.mdx'), '---\ntitle: No key\n---\nbody\n');
    writeFileSync(path.join(dir, '_a-dup.mdx'), '---\ntitle: A dup\nkey: a\n---\nbody a dup\n');
    const terms = readUpstreamTerms(dir);
    // Filesystem read order is not guaranteed, so only assert the invariants that matter: the
    // non-term partial is skipped, and exactly one of the two "a" partials survives.
    assert.deepEqual([...terms.keys()], ['a']);
    assert.ok(['body a', 'body a dup'].includes(terms.get('a').body.trim()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLocalTerms falls back to the filename when a file has no `id` frontmatter', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-glossary-local-'));
  try {
    writeFileSync(path.join(dir, 'no-id.mdx'), 'no frontmatter body\n');
    const terms = readLocalTerms(dir);
    assert.ok(terms.has('no-id'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveUpstreamRepo prefers --upstream over the env var and config', () => {
  const dir = mktempUpstreamRepo();
  try {
    const resolved = resolveUpstreamRepo(['--upstream', dir], {
      env: { UPSTREAM_DOCS_REPO: '/nowhere' },
    });
    assert.equal(resolved.repo, dir);
    assert.equal(resolved.docs, path.join(dir, 'docs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveUpstreamRepo falls back to the env var when no flag is passed', () => {
  const dir = mktempUpstreamRepo();
  try {
    const resolved = resolveUpstreamRepo([], { env: { UPSTREAM_DOCS_REPO: dir } });
    assert.equal(resolved.repo, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveUpstreamRepo resolves --tree-a, the shared resolver flag, as the docs tree itself', () => {
  const dir = mktempUpstreamRepo();
  try {
    const docs = path.join(dir, 'docs');
    const resolved = resolveUpstreamRepo(['--tree-a', docs], { env: {} });
    assert.equal(resolved.docs, docs);
    assert.equal(resolved.repo, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveUpstreamRepo resolves config paths against the repo root, not the cwd', () => {
  // The whole point of delegating to the shared resolver: `probePaths` must not move when the
  // script is invoked from a subdirectory.
  const config = { docsSubdir: 'docs', probePaths: ['../arbitrum-docs'] };
  const seen = [];
  const resolved = resolveUpstreamRepo([], {
    env: {},
    config,
    root: '/repo/root',
    cwd: '/repo/root/scripts/nested',
    exists: (p) => {
      seen.push(p);
      return p === '/repo/arbitrum-docs/docs';
    },
  });
  assert.equal(resolved.repo, '/repo/arbitrum-docs');
  assert.ok(!seen.some((p) => p.includes('nested')), `cwd leaked into ${seen.join(', ')}`);
});

test('convertBody preserves an #anchor when rewriting a .mdx doc link', () => {
  const dir = mktempDocsRoot();
  try {
    const out = convertBody(
      'See [chain params](/arbitrum-essentials/reference/chain-params.mdx#chain-parameters).',
      { varKeys: new Set(), docsRoot: dir, warn: () => {} },
    );
    assert.equal(
      out,
      'See [chain params](/docs/arbitrum-essentials/reference/chain-params#chain-parameters).',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertBody rewrites a relative .mdx doc link, with and without an anchor', () => {
  const dir = mktempDocsRoot();
  try {
    const out = convertBody(
      'A [x](arbitrum-essentials/reference/chain-params.mdx#foo) and [y](arbitrum-essentials/reference/chain-params.mdx).',
      { varKeys: new Set(), docsRoot: dir, warn: () => {} },
    );
    assert.equal(
      out,
      'A [x](/docs/arbitrum-essentials/reference/chain-params#foo) and [y](/docs/arbitrum-essentials/reference/chain-params).',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertBody warns exactly once about a .mdx link it cannot resolve', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-glossary-docs-'));
  const warnings = [];
  try {
    const out = convertBody('See [nowhere](for-devs/gone.mdx#frag).', {
      varKeys: new Set(),
      docsRoot: dir,
      warn: (msg) => warnings.push(msg),
      label: 'term.mdx',
    });
    assert.equal(out, 'See [nowhere](for-devs/gone.mdx#frag).');
    // The not-found resolver warning, not also the catch-all sweep.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not found under content\/docs\/ in term\.mdx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeForComparison treats upstream @@key@@ and a converted <Var> as equal', () => {
  // The idempotency case: convertBody turns @@x@@ into <Var name="x" />, so stripping only one
  // side would list the term as changed on every run and rewrite it forever.
  assert.equal(
    normalizeForComparison('Value is @@nitroVersionTag@@ today.'),
    normalizeForComparison('Value is <Var name="nitroVersionTag" /> today.'),
  );
});

test('normalizeForComparison is case-sensitive, so an upstream capitalization fix is drift', () => {
  assert.notEqual(
    normalizeForComparison('a Rollup chain'),
    normalizeForComparison('a rollup chain'),
  );
});

test('computeSets flags a term whose title changed even when the body is identical', () => {
  const upstream = new Map([['raas', { title: 'RaaS', sortAs: 'RaaS', body: 'same' }]]);
  const local = new Map([['raas', { title: 'raas', sortAs: 'RaaS', body: 'same' }]]);
  assert.deepEqual(computeSets(upstream, local).changed, ['raas']);
});

test('computeSets flags a sortAs change but not an omitted sortAs that equals the title', () => {
  // writeTermFile omits sortAs when it equals the title, while readUpstreamTerms defaults it to
  // the title, so comparing the raw fields would flag every term without an explicit sort key.
  const upstream = new Map([
    ['a', { title: 'A', sortAs: 'A', body: 'same' }],
    ['b', { title: 'B', sortAs: 'Zed', body: 'same' }],
  ]);
  const local = new Map([
    ['a', { title: 'A', sortAs: undefined, body: 'same' }],
    ['b', { title: 'B', sortAs: 'Bee', body: 'same' }],
  ]);
  assert.deepEqual(computeSets(upstream, local).changed, ['b']);
});

function mktempUpstreamRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-glossary-repo-'));
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

function mktempDocsRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-glossary-docs-'));
  const nested = path.join(dir, 'arbitrum-essentials', 'reference');
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, 'chain-params.mdx'), '---\ntitle: X\n---\nbody\n');
  return dir;
}
