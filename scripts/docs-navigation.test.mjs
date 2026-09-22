import { searchPath } from 'fumadocs-core/breadcrumb';
import { loader } from 'fumadocs-core/source';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { buildDocsNavigation, docsNavigationTransformer } from '../lib/docs-navigation.ts';

const contentRoot = new URL('../content/docs/', import.meta.url);
const { sections } = JSON.parse(
  readFileSync(new URL('../lib/docs-navigation.json', import.meta.url)),
);
const files = readdirSync(contentRoot, { recursive: true })
  .filter((path) => path.endsWith('.mdx') || path.endsWith('meta.json'))
  .map((path) => ({
    type: path.endsWith('.mdx') ? 'page' : 'meta',
    path,
    data: path.endsWith('.mdx')
      ? { title: path, sidebar_label: path === 'oracles/DIA/dia.mdx' ? 'DIA' : undefined }
      : JSON.parse(readFileSync(new URL(path, contentRoot))),
  }));
const source = loader({
  baseUrl: '/docs',
  source: { files },
  pageTree: {
    transformers: [docsNavigationTransformer(sections)],
  },
});
const tree = source.pageTree;
const roots = tree.children.filter((item) => item.type === 'folder' && item.root);
const section = (name) => roots.find((item) => item.name === name);
const names = (folder) => folder.children.map((item) => item.name);
const owner = (url) => searchPath(tree.children, url)?.findLast((item) => item.root)?.name;

test('section landing pages belong to the section itself, not Additional guides', () => {
  for (const section of sections) {
    const path = searchPath(tree.children, `/docs/${section.id}`);
    assert.equal(path.length, 2, section.id);
    assert.equal(path[0].name, section.name);
    assert.equal(path[1].type, 'page');
  }
});

function visit(nodes, fn) {
  for (const node of nodes) {
    fn(node);
    if (node.type === 'folder') {
      if (node.index) fn(node.index);
      visit(node.children, fn);
    }
  }
}

test('all local pages remain navigable and have exactly one section owner', () => {
  const ownership = new Map();
  for (const root of roots) {
    visit([root], (node) => {
      if (node.type !== 'page') return;
      const owners = ownership.get(node.url) ?? new Set();
      owners.add(root.name);
      ownership.set(node.url, owners);
    });
  }
  for (const page of source.getPages()) {
    assert.ok(searchPath(tree.children, page.url), `missing page ${page.url}`);
    if (page.url === '/docs') continue;
    assert.equal(ownership.get(page.url)?.size, 1, `ambiguous or absent owner for ${page.url}`);
  }
});

test('Get started restores the entry points and nests third-party docs and oracles', () => {
  assert.deepEqual(names(section('Get started')).slice(0, 17), [
    'Get started',
    'Arbitrum: introduction',
    'Build apps',
    'Arbitrum essentials',
    'Run an Arbitrum chain',
    'Run an Arbitrum node',
    'Arbitrum bridge',
    'How Arbitrum works',
    'Chain info',
    'Glossary',
    'Contribute',
    'FAQ',
    'Notices',
    'Audit reports',
    'Third-party docs',
    'DAO docs',
    'Prysm docs',
  ]);
  assert.equal(
    section('Get started').children.find((item) => item.name === 'Third-party docs').children[0]
      .name,
    'Oracles',
  );
  assert.equal(owner('/docs/oracles/chainlink/chainlink'), 'Get started');
  assert.equal(owner('/docs/chain-info'), 'Get started');
  const thirdParty = section('Get started').children.find(
    (item) => item.name === 'Third-party docs',
  );
  assert.ok(thirdParty.children.some((item) => item.$ref?.folder === 'third-party-docs/MetaMask'));
  assert.equal(searchPath(tree.children, '/docs/oracles/DIA/dia').at(-1).name, 'DIA');
});

test('Stylus follows the introduction, quickstart, fundamentals and guides learning sequence', () => {
  assert.deepEqual(names(section('Build apps with Stylus')).slice(0, 12), [
    'A gentle introduction',
    'Quickstart',
    'Fundamentals',
    'Guides',
    'CLI tools',
    'Best Practices',
    'Troubleshooting',
    'Concepts',
    'Advanced',
    'Reference',
    'Arbitrum essentials',
    'FAQ',
  ]);
});

test('chain configuration restores the original nested topics despite migrated file locations', () => {
  const chain = section('Run an Arbitrum chain');
  assert.deepEqual(names(chain).slice(0, 11), [
    'Overview',
    'Licensing',
    'FAQ',
    'Quickstart',
    'Chain configuration',
    'Deployment',
    'Integrations',
    'Migrate',
    'Operate',
    'Extend the protocol',
    'Run a node for an Arbitrum chain',
  ]);
  assert.deepEqual(
    names(chain.children.find((item) => item.name === 'Chain configuration')).slice(0, 6),
    ['Batch poster', 'Costs', 'Data availability', 'Execution', 'Sequencing', 'Validation'],
  );
});

test('cross-section shortcuts never steal their destination sidebar', () => {
  assert.equal(owner('/docs/stylus/quickstart'), 'Build apps with Stylus');
  assert.equal(
    owner('/docs/build-decentralized-apps/quickstart-solidity-remix'),
    'Build apps with Solidity',
  );
  assert.equal(owner('/docs/arbitrum-essentials/bridging/overview'), 'Arbitrum essentials');
  assert.equal(owner('/docs/run-a-node/run-full-node'), 'Run an Arbitrum node');
  visit(tree.children, (node) => {
    if (node.type === 'separator' && node.url?.startsWith('/docs')) {
      assert.ok(searchPath(tree.children, node.url), `unresolved shortcut ${node.url}`);
    }
  });
});

test('broken manifest entries fail instead of disappearing silently', () => {
  assert.throws(
    () =>
      buildDocsNavigation(tree, [
        {
          id: 'get-started',
          name: 'Get started',
          sourceFolders: ['get-started'],
          children: [{ page: '/docs/missing' }],
        },
      ]),
    /Navigation page does not exist/,
  );
});

// A page can set its own sidebar_label, and a manifest entry can rename that same page with its
// own `name`. Build a small synthetic source (rather than reusing the real content tree) so this
// case is exercised even when no page in content/docs happens to carry both right now.
function demoSource(children) {
  const files = [
    { type: 'meta', path: 'demo/meta.json', data: { title: 'Demo' } },
    { type: 'page', path: 'demo/index.mdx', data: { title: 'Demo landing' } },
    {
      type: 'page',
      path: 'demo/sample.mdx',
      data: { title: 'Sample page', sidebar_label: 'From frontmatter' },
    },
  ];
  const sections = [{ id: 'demo', name: 'Demo', sourceFolders: ['demo'], children }];
  return loader({
    baseUrl: '/docs',
    source: { files },
    pageTree: { transformers: [docsNavigationTransformer(sections)] },
  });
}

test("a manifest entry name wins over the page's own sidebar_label", () => {
  const tree = demoSource([{ page: '/docs/demo/sample', name: 'From manifest' }]).pageTree;
  const node = searchPath(tree.children, '/docs/demo/sample').at(-1);
  assert.equal(node.name, 'From manifest');
});

test('sidebar_label applies when the manifest entry gives the page no explicit name', () => {
  const tree = demoSource([{ page: '/docs/demo/sample' }]).pageTree;
  const node = searchPath(tree.children, '/docs/demo/sample').at(-1);
  assert.equal(node.name, 'From frontmatter');
});
