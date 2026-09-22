/**
 * generate-precompile-tables — regenerate content/partials/precompile-tables/*.mdx.
 *
 * Usage:
 *   pnpm precompiles:generate          # write the tables
 *   pnpm precompiles:check             # fail if any table on disk is stale
 *
 * For every precompile in scripts/data/precompiles-information.mjs, fetches the Solidity
 * interface and the Go implementation from the commits pinned in content/vars.json, pairs
 * each method and event with its source line, and emits an HTML table partial.
 *
 * Fetching pinned refs rather than reading a local nitro checkout is deliberate: the
 * emitted line-number links must correspond to an exact `nitroVersionTag`, not to whatever
 * happens to be in a working tree.
 *
 * This file is I/O only (fetch the pinned sources, write the result). Parsing and rendering
 * live in `scripts/lib/precompile-tables.mjs` (FS-2730) as pure functions, so
 * `scripts/lib/precompile-tables.test.mjs` can exercise them offline against fixture source,
 * without the network round trip that makes `pnpm precompiles:check` `continue-on-error` in CI.
 *
 * Ported from arbitrum-docs `scripts/precompile-reference-generator.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  nodeInterfaceInformation,
  precompilesInformation,
} from './data/precompiles-information.mjs';
import { isCheckMode, runScript, writeOrCheck } from './lib/generated-partial.mjs';
import {
  NODE_INTERFACE_MARKER,
  PRECOMPILE_MARKER,
  renderNodeInterfacePartial,
  renderPrecompilePartial,
  toRawUrl,
} from './lib/precompile-tables.mjs';

const OUTPUT_DIR = path.join('content', 'partials', 'precompile-tables');

/**
 * Pins that only this generator consumes. They stay here rather than in content/vars.json
 * because that file is the writer-facing set rendered by `<Var>` — these are never shown
 * to a reader. The shared pins (nitroVersionTag, nitroPrecompilesCommit, …) do live in
 * vars.json and are read from it below, so no value is duplicated across the two.
 */
const NODE_INTERFACE_PINS = {
  nitroContractsRepositorySlug: 'nitro-contracts',
  nitroContractsCommit: '4341b132cfbdcc980ead03765ca5224ff6cb5d97',
  nitroContractsPathToPrecompilesInterface: 'src/node-interface',
  nitroPrecompilesPathToInterfaces: '',
};

const vars = JSON.parse(fs.readFileSync(path.join('content', 'vars.json'), 'utf-8'));

const interfacePath = NODE_INTERFACE_PINS.nitroPrecompilesPathToInterfaces
  ? `/${NODE_INTERFACE_PINS.nitroPrecompilesPathToInterfaces}`
  : '';
const interfaceBaseUrl = `https://github.com/OffchainLabs/${vars.nitroPrecompilesRepositorySlug}/blob/${vars.nitroPrecompilesCommit}${interfacePath}/`;
const implementationBaseUrl = `https://github.com/OffchainLabs/${vars.nitroRepositorySlug}/blob/${vars.nitroVersionTag}/${vars.nitroPathToPrecompiles}/`;
const nodeInterfaceInterfaceBaseUrl = `https://github.com/OffchainLabs/${NODE_INTERFACE_PINS.nitroContractsRepositorySlug}/blob/${NODE_INTERFACE_PINS.nitroContractsCommit}/${NODE_INTERFACE_PINS.nitroContractsPathToPrecompilesInterface}/`;
const nodeInterfaceImplementationBaseUrl = `https://github.com/OffchainLabs/${vars.nitroRepositorySlug}/blob/${vars.nitroVersionTag}/execution/nodeinterface/`;

/**
 * Prettier options for the generated `.mdx` partials.
 *
 * These files are the one place MDX gets Prettier-formatted in this repo: `.prettierignore`
 * excludes `**\/*.mdx` from `pnpm format`, so nothing else touches them and the generator
 * owns their shape (the same arrangement the ignore file documents for CATALOG.md).
 *
 * `printWidth: 9999` keeps each `<a>` tag's attributes on one line, which is what the
 * committed tables already look like, so regenerating produces no formatting churn.
 *
 * Every partial now opens with one `{/* … *\/}` expression comment (the do-not-edit marker), so
 * the `*`-escaping hazard that motivates the repo-wide MDX exclusion is no longer ruled out by
 * the file's content. It still does not bite: that hazard is Prettier escaping a `*` in prose,
 * and these files hold an expression comment on its own line followed by HTML tables, with no
 * prose anywhere. Measured rather than assumed, with these exact options Prettier returns the
 * marker line byte-identical and is idempotent on the result, including for a marker carrying a
 * literal `*\/`. `generatedMarker` rejects that input anyway, so the case cannot reach here.
 */
const MDX_FORMAT = { parser: 'mdx', printWidth: 9999, proseWrap: 'preserve', plugins: [] };

async function fetchSource(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed fetching ${label} with status ${response.status}: ${url}`);
  }
  return response.text();
}

async function generatePrecompile(name, check, methodOverrides, eventOverrides) {
  const interfaceUrl = `${interfaceBaseUrl}${name}.sol`;
  const implementationUrl = `${implementationBaseUrl}${name}.go`;

  const interfaceCode = await fetchSource(toRawUrl(interfaceUrl), `${name} interface`);
  const implementationCode = await fetchSource(
    toRawUrl(implementationUrl),
    `${name} implementation`,
  );

  const content = renderPrecompilePartial({
    marker: PRECOMPILE_MARKER,
    interfaceCode,
    implementationCode,
    interfaceUrl,
    implementationUrl,
    methodOverrides,
    eventOverrides,
  });

  await writeOrCheck(path.join(OUTPUT_DIR, `_${name}.mdx`), content, {
    check,
    overrides: MDX_FORMAT,
  });
}

async function generateNodeInterface(check, methodOverrides) {
  const interfaceUrl = `${nodeInterfaceInterfaceBaseUrl}NodeInterface.sol`;
  const implementationUrl = `${nodeInterfaceImplementationBaseUrl}node_interface.go`;

  const interfaceCode = await fetchSource(toRawUrl(interfaceUrl), 'NodeInterface interface');
  const implementationCode = await fetchSource(
    toRawUrl(implementationUrl),
    'NodeInterface implementation',
  );

  const content = renderNodeInterfacePartial({
    marker: NODE_INTERFACE_MARKER,
    interfaceCode,
    implementationCode,
    interfaceUrl,
    implementationUrl,
    methodOverrides,
  });

  await writeOrCheck(path.join(OUTPUT_DIR, '_NodeInterface.mdx'), content, {
    check,
    overrides: MDX_FORMAT,
  });
}

async function main() {
  const check = isCheckMode();

  await Promise.all(
    Object.entries(precompilesInformation).map(([name, { methodOverrides, eventOverrides }]) =>
      generatePrecompile(name, check, methodOverrides, eventOverrides),
    ),
  );
  await generateNodeInterface(check, nodeInterfaceInformation.methodOverrides);

  console.log(
    check
      ? 'precompile tables: up to date.'
      : `precompile tables: generated ${Object.keys(precompilesInformation).length + 1} partial(s).`,
  );
}

runScript(main);
