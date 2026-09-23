import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { duplicateManifestPages } from '../lib/docs-navigation-rules.mjs';
import {
  checkDir,
  checkSections,
  classifyEntry,
  readSections,
  readTree,
  resolveRef,
} from './lib/nav.mjs';

test('classifyEntry recognises every meta.json entry form', () => {
  assert.equal(classifyEntry('my-page').kind, 'page');
  assert.equal(classifyEntry('...').kind, 'rest');
  assert.equal(classifyEntry('z...a').kind, 'rest');
  assert.equal(classifyEntry('[Chain info](/docs/chain-info)').kind, 'link');
  assert.equal(classifyEntry('---Section---').kind, 'separator');
  assert.equal(classifyEntry('!hidden-page').kind, 'exclude');
});

test('checkDir flags entries with no file on disk as ghosts', () => {
  const result = checkDir({
    dir: 'configuration',
    meta: { pages: ['layer-leap', 'core'] },
    entries: [
      { name: 'core', isDir: true },
      { name: 'index.mdx', isDir: false },
    ],
  });
  assert.deepEqual(result.ghosts, ['layer-leap']);
});

test('checkDir flags on-disk pages absent from pages[] when no rest operator', () => {
  const result = checkDir({
    dir: 'operate',
    meta: { pages: ['arbos-upgrade'] },
    entries: [
      { name: 'arbos-upgrade.mdx', isDir: false },
      { name: 'gas-target.mdx', isDir: false },
      { name: 'index.mdx', isDir: false },
    ],
  });
  assert.deepEqual(result.hidden, ['gas-target']);
  assert.equal(result.hasRest, false);
});

test('rest operator means nothing is hidden', () => {
  const result = checkDir({
    dir: 'operate',
    meta: { pages: ['arbos-upgrade', '...'] },
    entries: [
      { name: 'arbos-upgrade.mdx', isDir: false },
      { name: 'gas-target.mdx', isDir: false },
    ],
  });
  assert.deepEqual(result.hidden, []);
  assert.equal(result.hasRest, true);
});

test('index.mdx is never reported as hidden', () => {
  const result = checkDir({
    dir: 'x',
    meta: { pages: ['a'] },
    entries: [
      { name: 'a.mdx', isDir: false },
      { name: 'index.mdx', isDir: false },
    ],
  });
  assert.deepEqual(result.hidden, []);
});

test('index may legally be listed in pages and is not a ghost', () => {
  const result = checkDir({
    dir: 'x',
    meta: { pages: ['index', 'a'] },
    entries: [
      { name: 'a.mdx', isDir: false },
      { name: 'index.mdx', isDir: false },
    ],
  });
  assert.deepEqual(result.ghosts, []);
});

test('resolveRef walks out of the directory holding the meta.json', () => {
  assert.equal(resolveRef('resources', '../chain-info'), 'chain-info');
  assert.equal(resolveRef('resources', '../get-started/index'), 'get-started/index');
  assert.equal(resolveRef('', 'chain-info'), 'chain-info');
  assert.equal(resolveRef('stylus', 'how-tos/gas-metering'), 'stylus/how-tos/gas-metering');
});

/**
 * Section coverage (FS-2751). The rule this replaced read the `"root": true` flags in
 * `content/docs/**\/meta.json`, which were also its only input, so all it proved was that the flags
 * were declared. The flags are gone: since PR #73 the transformer overwrites `root` on every folder
 * node it emits, so deleting all twelve left the rendered tree structurally identical. What decides
 * where a page lands now is whether some section's `sourceFolders` reaches it.
 */

const SECTION = { id: 'notices', name: 'Notices', sourceFolders: ['notices'] };

test('checkSections flags a top-level directory no section covers', () => {
  const { uncoveredFolders, unsectioned } = checkSections({
    dirs: new Map([
      ['', { pages: ['notices', '...'] }],
      ['notices', { pages: ['...'] }],
      ['scratch-zone', { pages: ['...'] }],
    ]),
    pages: new Set(['notices/index', 'scratch-zone/probe']),
    sections: [SECTION],
  });
  assert.deepEqual(uncoveredFolders, ['scratch-zone']);
  // The directory is named once, not once per page inside it.
  assert.deepEqual(unsectioned, []);
});

test('checkSections flags a sourceFolders entry naming no directory', () => {
  const { missingFolders } = checkSections({
    dirs: new Map([
      ['', { pages: ['notices'] }],
      ['notices', { pages: ['...'] }],
    ]),
    pages: new Set(['notices/index']),
    sections: [{ ...SECTION, sourceFolders: ['notices', 'gone-missing'] }],
  });
  assert.deepEqual(missingFolders, [{ section: 'notices', folder: 'gone-missing' }]);
});

test('checkSections flags a source folder two sections claim', () => {
  const { sharedFolders } = checkSections({
    dirs: new Map([
      ['', { pages: ['notices'] }],
      ['notices', { pages: ['...'] }],
    ]),
    pages: new Set(['notices/index']),
    sections: [SECTION, { id: 'stylus', name: 'Stylus', sourceFolders: ['notices'] }],
  });
  assert.deepEqual(sharedFolders, [{ folder: 'notices', sections: ['notices', 'stylus'] }]);
});

test('checkSections covers a page inside a source folder', () => {
  const { uncoveredFolders, unsectioned } = checkSections({
    dirs: new Map([
      ['', { pages: ['notices'] }],
      ['notices', { pages: ['index', '...'] }],
    ]),
    pages: new Set(['notices/index', 'notices/fusaka-upgrade-notice']),
    sections: [SECTION],
  });
  assert.deepEqual(uncoveredFolders, []);
  assert.deepEqual(unsectioned, []);
});

test('checkSections flags a loose top-level page no directory claims', () => {
  // This is the shape `content/docs/resources/meta.json` exists to prevent: four pages sit at the
  // top of content/docs and only that meta.json's "../chain-info" references put them in a section.
  const { unsectioned } = checkSections({
    dirs: new Map([
      ['', { pages: ['resources', '...'] }],
      ['resources', { pages: ['../chain-info'] }],
    ]),
    pages: new Set(['chain-info', 'glossary']),
    sections: [{ id: 'get-started', name: 'Get started', sourceFolders: ['resources'] }],
  });
  assert.deepEqual(unsectioned, ['glossary']);
});

test('checkSections exempts the docs landing page and nothing else', () => {
  const { unsectioned } = checkSections({
    dirs: new Map([['', {}]]),
    pages: new Set(['index', 'glossary']),
    sections: [],
  });
  assert.deepEqual(unsectioned, ['glossary']);
});

test('checkSections inherits coverage through a cross-directory folder claim', () => {
  const { uncoveredFolders, unsectioned } = checkSections({
    dirs: new Map([
      ['', { pages: ['section', '...'] }],
      ['section', { pages: ['../loose'] }],
      ['loose', { pages: ['...'] }],
    ]),
    pages: new Set(['loose/a', 'loose/b']),
    sections: [{ id: 'section', name: 'Section', sourceFolders: ['section'] }],
  });
  assert.deepEqual(uncoveredFolders, []);
  assert.deepEqual(unsectioned, []);
});

test('checkSections flags a link entry that shadows a real page', () => {
  const { shadowLinks } = checkSections({
    dirs: new Map([
      ['', { pages: ['get-started', '...'] }],
      ['get-started', { pages: ['index', '[Chain info](/docs/chain-info)'] }],
    ]),
    pages: new Set(['index', 'chain-info', 'get-started/index']),
    sections: [{ id: 'get-started', name: 'Get started', sourceFolders: ['get-started'] }],
  });
  assert.deepEqual(shadowLinks, [
    { dir: 'get-started', entry: '[Chain info](/docs/chain-info)', page: 'chain-info' },
  ]);
});

test('checkSections flags every link-entry form fumadocs accepts, not only the plain one', () => {
  // fumadocs-core builds a link node from three shapes (see LINK_ENTRY in scripts/lib/nav.mjs).
  // All three become a `type: "page"` node with the literal url, so all three shadow a real page.
  for (const entry of [
    '[Chain info](/docs/chain-info)',
    '[BookOpen][Chain info](/docs/chain-info)',
    'external:[Chain info](/docs/chain-info)',
  ]) {
    assert.equal(classifyEntry(entry).kind, 'link', entry);
    const { shadowLinks } = checkSections({
      dirs: new Map([['', { pages: ['index', entry] }]]),
      pages: new Set(['index', 'chain-info']),
      sections: [],
    });
    assert.deepEqual(shadowLinks, [{ dir: '', entry, page: 'chain-info' }], entry);
  }
});

test('checkSections resolves a shadowing link through a folder index', () => {
  const { shadowLinks } = checkSections({
    dirs: new Map([['', { pages: ['[Notices](/docs/notices)', '...'] }]]),
    pages: new Set(['notices/index']),
    sections: [],
  });
  assert.deepEqual(shadowLinks, [
    { dir: '', entry: '[Notices](/docs/notices)', page: 'notices/index' },
  ]);
});

test('checkSections leaves alone a link entry that points outside the collection', () => {
  const { shadowLinks } = checkSections({
    dirs: new Map([
      ['', { pages: ['[Status](https://status.arbitrum.io)', '[Gone](/docs/gone)'] }],
    ]),
    pages: new Set([]),
    sections: [],
  });
  assert.deepEqual(shadowLinks, []);
});

/**
 * The manifest rule (FS-2740). Four `page` URLs in `lib/docs-navigation.json` were each claimed by
 * two entries, so four real pages fell into their section's Additional guides group while a sidebar
 * entry named them and opened something else. Every claimed URL existed, so nothing failed.
 */

test('duplicateManifestPages reports a page URL claimed twice, with both entry names', () => {
  const duplicates = duplicateManifestPages([
    {
      id: 'run-a-node',
      name: 'Run an Arbitrum node',
      sourceFolders: ['run-a-node'],
      children: [
        { name: 'Overview', page: '/docs/run-a-node/arbos-releases/overview' },
        { name: 'Elara (ArbOS 61)', page: '/docs/run-a-node/arbos-releases/overview' },
        { name: 'Dia (ArbOS 51)', page: '/docs/run-a-node/arbos-releases/arbos51' },
      ],
    },
  ]);
  assert.deepEqual(duplicates, [
    {
      url: '/docs/run-a-node/arbos-releases/overview',
      names: ['Overview', 'Elara (ArbOS 61)'],
    },
  ]);
});

test('duplicateManifestPages sees a claim nested in a children group or used as its index', () => {
  const duplicates = duplicateManifestPages([
    {
      id: 'launch-arbitrum-chain',
      name: 'Run an Arbitrum chain',
      sourceFolders: ['launch-arbitrum-chain'],
      children: [
        {
          name: 'Chain configuration',
          page: '/docs/launch-arbitrum-chain/configuration/sequencer',
          children: [
            {
              name: 'Sequencing',
              children: [
                {
                  name: 'Sequencer configuration reference',
                  page: '/docs/launch-arbitrum-chain/configuration/sequencer',
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(
    duplicates.map((d) => d.url),
    ['/docs/launch-arbitrum-chain/configuration/sequencer'],
  );
});

test('duplicateManifestPages leaves repeated href shortcuts alone', () => {
  // A repeated `href` is the documented way to pin one page into several sections: it builds a
  // display-only separator node that claims nothing, so it cannot steal a sidebar root.
  const duplicates = duplicateManifestPages([
    {
      id: 'build-decentralized-apps',
      name: 'Build apps with Solidity',
      sourceFolders: ['build-decentralized-apps'],
      children: [{ name: 'Bridging', href: '/docs/arbitrum-essentials/bridging/overview' }],
    },
    {
      id: 'stylus',
      name: 'Build apps with Stylus',
      sourceFolders: ['stylus'],
      children: [
        { name: 'Bridging', href: '/docs/arbitrum-essentials/bridging/overview' },
        { name: 'Bridging', page: '/docs/arbitrum-essentials/bridging/overview' },
      ],
    },
  ]);
  assert.deepEqual(duplicates, []);
});

test('the real navigation manifest claims no page URL twice', () => {
  const manifest = new URL('../lib/docs-navigation.json', import.meta.url);
  assert.deepEqual(duplicateManifestPages(readSections(fileURLToPath(manifest))), []);
});

test('the real manifest and the real content tree agree on section coverage', () => {
  const sections = readSections(
    fileURLToPath(new URL('../lib/docs-navigation.json', import.meta.url)),
  );
  const tree = readTree(fileURLToPath(new URL('../content/docs', import.meta.url)));
  const { missingFolders, sharedFolders, uncoveredFolders, unsectioned } = checkSections({
    ...tree,
    sections,
  });
  assert.deepEqual(missingFolders, []);
  assert.deepEqual(sharedFolders, []);
  assert.deepEqual(uncoveredFolders, []);
  assert.deepEqual(unsectioned, []);
  // Every top-level directory is named exactly once, which is what makes the three lists empty.
  const topLevel = [...tree.dirs.keys()].filter((dir) => dir !== '' && !dir.includes('/'));
  const claimed = sections.flatMap((section) => section.sourceFolders);
  assert.deepEqual([...topLevel].sort(), [...claimed].sort());
});
