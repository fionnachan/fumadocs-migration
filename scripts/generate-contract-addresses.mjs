/**
 * generate-contract-addresses: regenerate the contract-address reference partial.
 *
 * Usage:
 *   pnpm contracts:generate          # write content/partials/_reference-arbitrum-contract-addresses-partial.mdx
 *   pnpm contracts:check             # exit 1, with a diff summary, when the committed partial is stale
 *
 * Sources of truth:
 * - `@arbitrum/sdk` for protocol-core and token-bridge addresses (rollup, inbox, sequencerInbox,
 *   bridge, outbox, classic outboxes, gateways, WETH, proxy admins, multicall). These follow
 *   automatically when the SDK devDependency is bumped, which is the whole point of the port:
 *   the partial used to be a static file that nothing kept honest.
 * - `scripts/data/contract-addresses.data.mjs` for what the SDK does not expose (core proxy
 *   admin, fraud-proof contracts, resource constraint manager, canonical factories) and for the
 *   constant precompile addresses.
 *
 * Unlike `generate-precompile-tables.mjs` this makes no network calls: the SDK ships its network
 * registry as data, so a run is offline and deterministic.
 *
 * Ported from arbitrum-docs `scripts/generate-contract-addresses.ts`.
 */
import { getArbitrumNetwork } from '@arbitrum/sdk';
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';

import * as data from './data/contract-addresses.data.mjs';
import { buildContent } from './lib/contract-addresses.mjs';
import { StaleFileError, isCheckMode, runScript, writeOrCheck } from './lib/generated-partial.mjs';

const OUTPUT_PATH = path.join(
  'content',
  'partials',
  '_reference-arbitrum-contract-addresses-partial.mdx',
);

/**
 * Prettier options for the generated `.mdx` partial, matching `generate-precompile-tables.mjs`.
 *
 * `.prettierignore` excludes `**\/*.mdx` from `pnpm format`, so nothing else reformats this file
 * and the generator owns its shape. `printWidth: 9999` keeps each `<AEL>` tag on one line, which
 * is what the committed partial already looks like, so regenerating produces no formatting churn.
 * Prettier is also what aligns the table columns, so the generator emits loose pipes and lets the
 * formatter settle on one canonical width.
 */
const MDX_FORMAT = { parser: 'mdx', printWidth: 9999, proseWrap: 'preserve', plugins: [] };

/**
 * Summarise how the committed partial differs from what this run would write. `--check` is the
 * CI signal, and "the file is stale" on its own does not say whether an address moved or only
 * whitespace did, which is exactly what a reviewer of the weekly refresh PR needs to know.
 *
 * @param {string} filePath
 * @param {string} content unformatted generator output
 * @returns {Promise<string>}
 */
async function diffSummary(filePath, content) {
  const config = await prettier.resolveConfig(filePath);
  const expected = await prettier.format(content, { ...config, filepath: filePath, ...MDX_FORMAT });
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';

  const currentLines = current.split('\n');
  const expectedLines = expected.split('\n');
  const lines = [];
  let changed = 0;

  for (let i = 0; i < Math.max(currentLines.length, expectedLines.length); i++) {
    if (currentLines[i] === expectedLines[i]) continue;
    changed++;
    if (currentLines[i] !== undefined) lines.push(`  - ${currentLines[i]}`);
    if (expectedLines[i] !== undefined) lines.push(`  + ${expectedLines[i]}`);
  }

  return [`${changed} line(s) differ (- committed, + generated):`, ...lines].join('\n');
}

async function main() {
  const check = isCheckMode();

  const { chains } = data;
  const networks = Object.fromEntries(chains.map((c) => [c.key, getArbitrumNetwork(c.childId)]));
  const content = buildContent({ chains, networks, data });

  try {
    await writeOrCheck(OUTPUT_PATH, content, { check, overrides: MDX_FORMAT });
  } catch (error) {
    if (error instanceof StaleFileError) console.error(await diffSummary(OUTPUT_PATH, content));
    throw error;
  }

  console.log(
    check
      ? 'contract addresses: up to date.'
      : `contract addresses: rendered ${data.chains.length} chain column(s).`,
  );
}

runScript(main);
