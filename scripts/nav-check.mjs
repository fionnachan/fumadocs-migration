/**
 * nav-check: fail on navigation defects in the meta.json tree and in the navigation manifest.
 *
 * Five rules, all invisible to `types:check` and `build`:
 *   - ghost entries: a `pages` entry naming nothing on disk (silently ignored by Fumadocs).
 *   - hidden pages: a file on disk that no `pages` entry and no `"..."` lets through.
 *   - source folders: a `sourceFolders` entry naming no directory, a directory two sections claim,
 *     and a top-level directory or loose page no section covers, which renders above the sections
 *     with no section sidebar (FS-2751).
 *   - shadowing links: a `pages` link entry pointing at a real page in this repo, which renames it
 *     and can pull it into the linking directory's section (FS-2716).
 *   - manifest duplicates: a `page` URL claimed twice in `lib/docs-navigation.json`, which leaves
 *     one entry naming a page it does not open (FS-2740).
 *
 * Usage:
 *   pnpm nav:check          # human report; exits 1 if any defect exists
 *   pnpm nav:check --json   # JSON to stdout; exits 0 (for tooling)
 */
import path from 'node:path';

import { duplicateManifestPages } from '../lib/docs-navigation-rules.mjs';
import { checkSections, checkTree, readSections, readTree } from './lib/nav.mjs';

function main() {
  const json = process.argv.slice(2).includes('--json');
  const root = path.join(process.cwd(), 'content', 'docs');
  const results = checkTree(root);
  const sections = readSections(path.join(process.cwd(), 'lib', 'docs-navigation.json'));
  const { missingFolders, sharedFolders, uncoveredFolders, unsectioned, shadowLinks } =
    checkSections({ ...readTree(root), sections });
  const duplicates = duplicateManifestPages(sections);

  if (json) {
    console.log(
      JSON.stringify({
        directories: results.map((r) => ({ ...r, dir: path.relative(process.cwd(), r.dir) })),
        missingFolders,
        sharedFolders,
        uncoveredFolders,
        unsectioned,
        shadowLinks,
        duplicates,
      }),
    );
    return;
  }

  const defects =
    results.length +
    missingFolders.length +
    sharedFolders.length +
    uncoveredFolders.length +
    unsectioned.length +
    shadowLinks.length +
    duplicates.length;
  if (defects === 0) {
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

  if (missingFolders.length > 0) {
    console.error(
      `nav-check: ${missingFolders.length} sourceFolders entry/entries in lib/docs-navigation.json naming a directory that does not exist, which makes the transformer throw and the dev server fail:`,
    );
    for (const f of missingFolders) console.error(`  ${f.section}: "${f.folder}"`);
    console.error(
      '    Fix: name an existing directory under content/docs, or drop the entry if the directory is gone.',
    );
  }

  if (sharedFolders.length > 0) {
    console.error(
      `nav-check: ${sharedFolders.length} source folder(s) claimed by more than one section, so only the section listed first collects anything from it:`,
    );
    for (const f of sharedFolders)
      console.error(`  "${f.folder}"\n    claimed by: ${f.sections.join(', ')}`);
    console.error(
      '    Fix: leave the folder in the one section that should hold its unlisted pages. Use "href" entries for cross-section shortcuts.',
    );
  }

  if (uncoveredFolders.length > 0) {
    console.error(
      `nav-check: ${uncoveredFolders.length} top-level director(y/ies) named in no section's sourceFolders, so their pages render above the sections with no section sidebar:`,
    );
    for (const dir of uncoveredFolders) console.error(`  content/docs/${dir}/`);
    console.error(
      '    Fix: add the directory name to one section\'s "sourceFolders" array in lib/docs-navigation.json.',
    );
  }

  if (unsectioned.length > 0) {
    console.error(
      `nav-check: ${unsectioned.length} page(s) no section covers, so they render above the sections with no section sidebar:`,
    );
    for (const page of unsectioned) console.error(`  content/docs/${page}.mdx`);
    console.error(
      '    Fix: claim the page from a directory a section already covers (a "../name" entry in that directory\'s meta.json, as content/docs/resources/meta.json does), or give its own directory a "sourceFolders" entry.',
    );
  }

  if (shadowLinks.length > 0) {
    console.error(
      `nav-check: ${shadowLinks.length} link entry/entries pointing at a real docs page, which overwrites that page's sidebar label and can pull it into this directory's section:`,
    );
    for (const s of shadowLinks)
      console.error(
        `  content/docs/${s.dir ? `${s.dir}/` : ''}meta.json: ${s.entry} -> content/docs/${s.page}.mdx`,
      );
    console.error(
      '    Fix: reference the page ("../name") from the one directory that should own it, and link to it with an "href" entry in lib/docs-navigation.json.',
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
