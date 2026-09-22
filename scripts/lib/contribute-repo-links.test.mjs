/**
 * Tripwire for the contribute guide's links back into this repository (FS-2733).
 *
 * `content/partials/_contribute-docs-partial.mdx` is the only page that links to files in this
 * repository by URL, and `scripts/check-links.mjs` skips every external destination before
 * resolving it. So when those URLs hardcoded the repository name, a rename would have left six dead
 * links on `/docs/contribute` with no gate turning red, and the only thing standing between the
 * reader and that was a comment asking a human to retarget them by hand.
 *
 * The URLs now read `{var:docsRepositoryUrl}/blob/{var:docsRepositoryBranch}/…`, and
 * `gitConfig` in `lib/shared.ts` reads the same two keys, so one edit to `content/vars.json` moves
 * the content and the code together. This test is what holds that: it expands the placeholders the
 * way the site does and asserts every GitHub URL the page renders belongs to the repository
 * `gitConfig` names.
 *
 * `lib/shared.ts` is imported as `.ts` for the reason `scripts/lib/shared.test.mjs` gives: Node 22
 * strips types natively, so this asserts against the exact constant the pages render rather than a
 * copy of it. `lib/var-links.mjs` supplies the expansion for the same reason, since a checker has
 * to judge the URL the reader gets, not the one written in the file.
 *
 * The HTTP half lives in `scripts/static-docs-http.test.mjs`, which proves the placeholders really
 * expanded in the rendered page rather than shipping as literal braces. This half needs no running
 * site, so it runs in `pnpm test` and therefore in CI's blocking `Gates` job.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitConfig } from '../../lib/shared.ts';
import { expandVarPlaceholders, readVars } from '../../lib/var-links.mjs';
import { stripCode } from './strip-code.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const partialPath = path.join(repoRoot, 'content/partials/_contribute-docs-partial.mdx');

/**
 * GitHub URLs this page may name that are not this repository.
 *
 * `OffchainLabs/arbitrum-docs` is the "fork the Arbitrum docs repo" step, left pointing at the name
 * this repository takes over at cutover; the partial carries an inline comment saying so. The
 * `handle` URL is the placeholder profile in the community-contribution banner example, so it is an
 * illustration rather than a link anyone is meant to follow.
 */
const ALLOWED = new Set([
  'https://github.com/OffchainLabs/arbitrum-docs',
  'https://github.com/handle',
]);

/** Every GitHub URL the reader is served, with the placeholders expanded. */
function renderedGithubUrls() {
  const prose = stripCode(readFileSync(partialPath, 'utf8'));
  const expanded = expandVarPlaceholders(prose, readVars());
  return [...expanded.matchAll(/https:\/\/github\.com\/[^\s)"'`<>\]]+/g)].map((m) =>
    m[0].replace(/[.,;:]+$/, ''),
  );
}

test('gitConfig holds exactly what content/vars.json holds', () => {
  const vars = readVars();
  assert.equal(gitConfig.url, vars.docsRepositoryUrl);
  assert.equal(gitConfig.branch, vars.docsRepositoryBranch);
});

test('every GitHub link in the contribute guide names the repository gitConfig names', () => {
  const urls = renderedGithubUrls();
  const own = urls.filter((url) => url === gitConfig.url || url.startsWith(`${gitConfig.url}/`));
  // Without this the test would still pass on a file whose links had all been deleted.
  assert.ok(own.length > 0, 'no link back into this repository survived');

  const offenders = urls.filter((url) => !own.includes(url) && !ALLOWED.has(url));
  assert.deepEqual(offenders, []);
});

test('the contribute guide never writes this repository URL out in full', () => {
  const source = readFileSync(partialPath, 'utf8');
  assert.ok(
    !source.includes(gitConfig.url),
    `${gitConfig.url} is written literally; use {var:docsRepositoryUrl} so one edit moves every link`,
  );
});
