/**
 * Tripwire for the content tree's links back into this repository (FS-2733).
 *
 * `scripts/check-links.mjs` skips every external destination before resolving it, so a link that
 * spells this repository's own GitHub URL out in full is invisible to every gate. When the
 * contribute guide hardcoded six such URLs, a rename would have left six dead links on
 * `/docs/contribute` with nothing turning red, and the only thing standing between the reader and
 * that was a comment asking a human to retarget them by hand.
 *
 * The URLs now read `{var:docsRepositoryUrl}/blob/{var:docsRepositoryBranch}/…`, and `gitConfig` in
 * `lib/shared.ts` reads the same two keys, so one edit to `content/vars.json` moves the content and
 * the code together. This file is what holds that, in three assertions:
 *
 * 1. `gitConfig` and `content/vars.json` agree, with no server running.
 * 2. Every GitHub link the contribute guide renders belongs to the repository `gitConfig` names.
 * 3. No `.mdx` file anywhere under `content/` writes a docs-repository URL out in full.
 *
 * The third one is deliberately repository-wide rather than pinned to the contribute guide. The
 * argument for the check is that `check-links` skips external destinations, and that argument holds
 * for every content file, not one: the round 1 review of FS-2733 found a second reader-facing issue
 * link, in `_know-more-tools-box-partial.mdx`, that a single-file check could never have seen.
 *
 * It judges both of the repository's names. `gitConfig.url` is what it is called today, and
 * `CUTOVER_URL` is the `OffchainLabs/arbitrum-docs` name it takes over, which is the name a stale
 * link is most likely to carry. After cutover the two collapse into one and the rule narrows
 * itself. Other `OffchainLabs/*` repositories are not this repository and are not checked: `nitro`,
 * `nitro-contracts` and the rest are separate projects that the cutover does not move.
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
import { walk } from './partials.mjs';
import { stripCode } from './strip-code.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contentDir = path.join(repoRoot, 'content');
const partialPath = path.join(repoRoot, 'content/partials/_contribute-docs-partial.mdx');

/**
 * The name this repository takes over at cutover. A link naming it is still a link to these docs,
 * so the rule below judges it alongside `gitConfig.url` rather than treating it as somebody else's
 * repository. Once `docsRepositoryUrl` flips to this value the two are the same string.
 */
const CUTOVER_URL = 'https://github.com/OffchainLabs/arbitrum-docs';

/**
 * GitHub URLs the contribute guide may name that are not this repository.
 *
 * `OffchainLabs/arbitrum-docs` is the "fork the Arbitrum docs repo" step, covered by the exception
 * below. The `handle` URL is the placeholder profile in the community-contribution banner example,
 * so it is an illustration rather than a link anyone is meant to follow.
 */
const ALLOWED = new Set([CUTOVER_URL, 'https://github.com/handle']);

/**
 * The only places a docs-repository URL may be written out in full, keyed by repository-relative
 * path. Keep this list short: every entry is a link that one edit to `content/vars.json` will not
 * move.
 */
const LITERAL_URL_EXCEPTIONS = new Map([
  [
    // The "fork the Arbitrum docs repo" step. It names the repository this one takes over, which is
    // where an external contributor forks from today, so it is deliberately already on the far side
    // of the cutover flip. The partial carries an inline comment saying the same thing.
    'content/partials/_contribute-docs-partial.mdx',
    [CUTOVER_URL],
  ],
]);

/** Whether `url` addresses the repository at `base`, rather than one whose name merely starts alike. */
function isUnder(url, base) {
  return url === base || url.startsWith(`${base}/`);
}

/** Every GitHub URL in `source`, outside code, with trailing sentence punctuation dropped. */
function githubUrls(source) {
  return [...stripCode(source).matchAll(/https:\/\/github\.com\/[^\s)"'`<>\]]+/g)].map((m) =>
    m[0].replace(/[.,;:]+$/, ''),
  );
}

test('gitConfig holds exactly what content/vars.json holds', () => {
  const vars = readVars();
  assert.equal(gitConfig.url, vars.docsRepositoryUrl);
  assert.equal(gitConfig.branch, vars.docsRepositoryBranch);
});

test('every GitHub link in the contribute guide names the repository gitConfig names', () => {
  const urls = githubUrls(expandVarPlaceholders(readFileSync(partialPath, 'utf8'), readVars()));
  const own = urls.filter((url) => isUnder(url, gitConfig.url));
  // Without this the test would still pass on a file whose links had all been deleted.
  assert.ok(own.length > 0, 'no link back into this repository survived');

  const offenders = urls.filter((url) => !own.includes(url) && !ALLOWED.has(url));
  assert.deepEqual(offenders, []);
});

test('no content file writes a docs-repository URL out in full', () => {
  const bases = [...new Set([gitConfig.url, CUTOVER_URL])];
  const files = walk(contentDir, (p) => p.endsWith('.mdx'));
  assert.ok(files.length > 0, 'no .mdx files found under content/, so this test proved nothing');

  const offenders = [];
  let placeholderUses = 0;
  for (const abs of files) {
    const rel = path.relative(repoRoot, abs);
    const source = readFileSync(abs, 'utf8');
    if (source.includes('{var:docsRepositoryUrl}')) placeholderUses += 1;
    const allowed = LITERAL_URL_EXCEPTIONS.get(rel) ?? [];
    for (const url of githubUrls(source)) {
      if (!bases.some((base) => isUnder(url, base))) continue;
      if (allowed.some((exception) => isUnder(url, exception))) continue;
      offenders.push(`${rel}: ${url}`);
    }
  }

  // Without this the test would still pass on a tree where every placeholder had been deleted.
  assert.ok(placeholderUses > 0, 'no content file uses {var:docsRepositoryUrl}');
  assert.deepEqual(
    offenders,
    [],
    'write {var:docsRepositoryUrl} so one edit to content/vars.json moves every link home',
  );
});
