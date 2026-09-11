/**
 * faq-data-check — fail when a `faqsId` used in `content/docs` has no matching data file, or a
 * data file under `components/mdx/FAQStructuredData/data/` is malformed.
 *
 * Usage:
 *   node scripts/faq-data-check.mjs          # human report; exits 1 on any defect
 *   node scripts/faq-data-check.mjs --json   # JSON report to stdout; exits 0 (for tooling)
 */
import path from 'node:path';

import { checkFaqData } from './lib/faq-data.mjs';

function main() {
  const json = process.argv.slice(2).includes('--json');
  const docsRoot = path.join(process.cwd(), 'content', 'docs');
  const dataDir = path.join(process.cwd(), 'components', 'mdx', 'FAQStructuredData', 'data');

  const { missingDataFile, malformed, unusedDataFile } = checkFaqData({ docsRoot, dataDir });

  if (json) {
    console.log(JSON.stringify({ missingDataFile, malformed, unusedDataFile }));
    return;
  }

  if (missingDataFile.length === 0 && malformed.length === 0 && unusedDataFile.length === 0) {
    console.log('faq-data-check: every faqsId has a well-formed data file.');
    return;
  }

  if (missingDataFile.length > 0) {
    console.error(
      `faq-data-check: ${missingDataFile.length} faqsId(s) used in content/docs with no matching data file:`,
    );
    for (const { id, sites } of missingDataFile) {
      console.error(`  "${id}"`);
      for (const s of sites) console.error(`      ${s.rel}:${s.line}`);
    }
  }

  if (malformed.length > 0) {
    console.error(`faq-data-check: ${malformed.length} malformed data file(s):`);
    for (const { id, file, issues } of malformed) {
      console.error(`  ${file} (id "${id}")`);
      for (const issue of issues) console.error(`      ${issue}`);
    }
  }

  if (unusedDataFile.length > 0) {
    // Not a failure on its own — just worth surfacing so a stale file gets noticed.
    console.warn(
      `faq-data-check: ${unusedDataFile.length} data file(s) with no faqsId usage in content/docs: ${unusedDataFile.join(', ')}`,
    );
  }

  if (missingDataFile.length > 0 || malformed.length > 0) {
    process.exitCode = 1;
  }
}

main();
