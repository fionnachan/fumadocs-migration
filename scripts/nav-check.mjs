/**
 * nav-check: fail on navigation defects in the meta.json tree and in the navigation manifest.
 *
 * Four rules, all invisible to `types:check` and `build`:
 *   - ghost entries: a `pages` entry naming nothing on disk (silently ignored by Fumadocs).
 *   - hidden pages: a file on disk that no `pages` entry and no `"..."` lets through.
 *   - root coverage: a page outside every `"root": true` folder, or a link entry that shadows a
 *     real page and so steals its sidebar root (FS-2716).
 *   - manifest duplicates: a `page` URL claimed twice in `lib/docs-navigation.json`, which leaves
 *     one entry naming a page it does not open (FS-2740).
 *
 * Usage:
 *   pnpm nav:check          # human report; exits 1 if any defect exists
 *   pnpm nav:check --json   # JSON to stdout; exits 0 (for tooling)
 */
import path from 'node:path';

import { checkManifest, checkRoots, checkTree, readTree } from './lib/nav.mjs';

function main() {
  const json = process.argv.slice(2).includes('--json');
  const root = path.join(process.cwd(), 'content', 'docs');
  const results = checkTree(root);
  const { rootless, shadowLinks } = checkRoots(readTree(root));
  const duplicates = checkManifest(path.join(process.cwd(), 'lib', 'docs-navigation.json'));

  if (json) {
    console.log(
      JSON.stringify({
        directories: results.map((r) => ({ ...r, dir: path.relative(process.cwd(), r.dir) })),
        rootless,
        shadowLinks,
        duplicates,
      }),
    );
    return;
  }

  if (
    results.length === 0 &&
    rootless.length === 0 &&
    shadowLinks.length === 0 &&
    duplicates.length === 0
  ) {
    console.log('nav-check: no navigation defects.');
    return;
  }

  if (results.length > 0) {
    console.error(`nav-check: ${results.length} directory/directories with navigation defects:`);
    for (const r of results) {
      const rel = path.relative(process.cwd(), r.dir);
      if (r.ghosts.length)
        console.error(`  ${rel}\n    ghost entries (listed, not on disk): ${r.ghosts.join(', ')}`);
      if (r.hidden.length)
        console.error(`    hidden pages (on disk, not listed, no "..."): ${r.hidden.join(', ')}`);
    }
  }

  if (rootless.length > 0) {
    console.error(
      `nav-check: ${rootless.length} page(s) outside every "root": true folder, so the sidebar root switcher names the wrong section or nothing at all:`,
    );
    for (const page of rootless) console.error(`  content/docs/${page}.mdx`);
    console.error(
      '    Fix: declare "root": true on a folder above the page, or list it from a root folder\'s "pages" (a "../name" reference works across directories).',
    );
  }

  if (shadowLinks.length > 0) {
    console.error(
      `nav-check: ${shadowLinks.length} link entry/entries pointing at a real docs page, which hands that page this folder's sidebar root:`,
    );
    for (const s of shadowLinks)
      console.error(
        `  content/docs/${s.dir ? `${s.dir}/` : ''}meta.json: ${s.entry} -> content/docs/${s.page}.mdx`,
      );
    console.error(
      '    Fix: reference the page ("../name") from the one root folder that should own it, and drop the duplicate link.',
    );
  }

  if (duplicates.length > 0) {
    console.error(
      `nav-check: ${duplicates.length} page URL(s) claimed more than once in lib/docs-navigation.json, so one entry names a page it does not open and that page falls into Additional guides:`,
    );
    for (const d of duplicates) console.error(`  ${d.url}\n    claimed by: ${d.names.join(', ')}`);
    console.error(
      '    Fix: point each entry at the page it names. Use "href" for a cross-section shortcut, which claims nothing.',
    );
  }

  process.exitCode = 1;
}

main();
