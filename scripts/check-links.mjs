/**
 * check-links — fail on broken internal doc links.
 *
 * Usage:
 *   pnpm check-links           # human report; exits 1 if any broken link exists
 *   pnpm check-links --json    # JSON array of broken links to stdout; exits 0 (for tooling/diffs)
 *
 * Replicates Docusaurus's `onBrokenLinks: 'throw'`, which the Fumadocs build does not do. Walks every
 * `content/docs/**` `.md(x)` file and asserts that each internal link (markdown, JSX `href`/`to`,
 * `<include>`) resolves to an existing file. Fragments are checked against the site's MDX pipeline,
 * including nested partials and custom heading ids. External links and dynamic JSX attrs are skipped.
 */
import { findBrokenAnchors } from './lib/doc-anchors.mjs';
import { buildIndex, findBrokenLinks } from './lib/doc-links.mjs';

async function main() {
  const json = process.argv.slice(2).includes('--json');
  const index = buildIndex(process.cwd());
  const broken = [...findBrokenLinks(index), ...(await findBrokenAnchors(index))];

  if (json) {
    console.log(JSON.stringify(broken.map(({ rel, line, url }) => ({ rel, line, url }))));
    return;
  }

  if (broken.length === 0) {
    console.log('check-links: no broken internal links.');
    return;
  }

  console.error(`check-links: ${broken.length} broken internal link(s):`);
  for (const b of broken) {
    console.error(
      `  ${b.rel}:${b.line}  ->  ${b.url}${b.reason ? ` (${b.reason}; on ${b.page})` : ''}`,
    );
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(`check-links: ${error.message}`);
  process.exitCode = 1;
});
