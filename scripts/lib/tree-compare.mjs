/**
 * tree-compare — normalize the legacy Docusaurus tree onto this repo's layout.
 *
 * A raw path diff between the two trees is meaningless: the legacy tree carries Docusaurus numeric
 * ordering prefixes, and several sections were renamed during the migration. These helpers apply
 * those corrections so paths can be compared.
 */

/** Tree A section prefix -> Tree B section prefix. Longest match wins. */
export const SECTION_MAP = {
  'launch-arbitrum-chain/chain-config': 'launch-arbitrum-chain/configuration',
  'for-devs/third-party-docs': 'third-party-docs',
  'for-devs/oracles': 'oracles',
  'run-arbitrum-node': 'run-a-node',
  'stylus-by-example': 'stylus',
};

/**
 * Whole-file renames, Tree A relative path -> Tree B relative path.
 *
 * Pairing is otherwise done on the normalized slug, which cannot match a page whose filename changed
 * during the migration. Without these entries the renamed pages below are reported ABSENT (looks like
 * a missing page) instead of GUTTED (a present page that lost content), the wrong verdict for the
 * wrong reason. Add an entry here whenever a port renames a file.
 *
 * A value is normally the Tree B path. It may instead be `{ to, merge: true }`, which says this
 * upstream page was deliberately folded into a Tree B page that another upstream page also maps to.
 * `pairTrees` refuses to let two upstream pages claim one Tree B file unless both say `merge`, so
 * the flag is what separates an intended merge from an accidental collision.
 */
export const RENAME_MAP = {
  'for-devs/contribute.mdx': 'contribute.mdx',
  // The port renamed the gentle intro to stf.mdx and expanded it (ratio 1.74, so no content loss).
  // Without this the page reported ABSENT while local stf.mdx was left to be claimed by upstream's
  // unrelated extend-the-protocol/stf.mdx how-to, which made it look GUTTED at 0.20.
  'how-arbitrum-works/deep-dives/01-stf-gentle-intro.mdx': 'how-arbitrum-works/deep-dives/stf.mdx',
  'for-devs/oracles/oracles-content-map.mdx': 'oracles/index.mdx',
  'get-started/overview.mdx': 'get-started/index.mdx',
  // Deliberate merge: upstream splits batch-poster and assertion config across two pages and the
  // port combined them, so both upstream paths legitimately point at one local file.
  'launch-arbitrum-chain/chain-config/batch-poster/config-batch-poster.mdx': {
    to: 'launch-arbitrum-chain/configuration/sequencer/batch-posting-assertion-control.mdx',
    merge: true,
  },
  'launch-arbitrum-chain/chain-config/batch-poster/enable-4844-blobs.mdx':
    'launch-arbitrum-chain/configuration/data-availability/enable-post-4844-blobs.mdx',
  'launch-arbitrum-chain/chain-config/batch-poster/fee-tuning.mdx':
    'launch-arbitrum-chain/configuration/sequencer/batch-poster-fee-tuning.mdx',
  'launch-arbitrum-chain/chain-config/costs/aep-overview.mdx':
    'launch-arbitrum-chain/configuration/costs/aep-fee-router-introduction.mdx',
  'launch-arbitrum-chain/chain-config/costs/aep-router-contracts.mdx':
    'launch-arbitrum-chain/configuration/costs/set-up-aep-fee-router.mdx',
  'launch-arbitrum-chain/chain-config/costs/configure-native-mint-burn.mdx':
    'launch-arbitrum-chain/configuration/costs/configure-native-mint-burn-gas-token.mdx',
  'launch-arbitrum-chain/chain-config/costs/custom-gas-token-anytrust.mdx':
    'launch-arbitrum-chain/configuration/costs/use-a-custom-gas-token-anytrust.mdx',
  'launch-arbitrum-chain/chain-config/costs/custom-gas-token-rollup.mdx':
    'launch-arbitrum-chain/configuration/costs/use-a-custom-gas-token-rollup.mdx',
  // Same page, renamed in the port: identical title ("Configure and optimize gas") and body. Without
  // this it fell through to the bare-slug fallback and paired against the unrelated Stylus
  // best-practices/gas-optimization.mdx, whose line count happened to clear the 70% ratio, so the
  // mispairing never surfaced as a finding at all.
  'launch-arbitrum-chain/chain-config/costs/gas-optimization.mdx':
    'launch-arbitrum-chain/configuration/costs/gas-optimization-tools.mdx',
  'launch-arbitrum-chain/chain-config/costs/dynamic-pricing.mdx':
    'launch-arbitrum-chain/configuration/costs/dynamic-pricing-for-arbitrum-chains.mdx',
  'launch-arbitrum-chain/chain-config/data-availability/dac-get-started.mdx':
    'launch-arbitrum-chain/configuration/data-availability/data-availability-committees/get-started.mdx',
  'launch-arbitrum-chain/chain-config/execution/smart-contract-size-limit.mdx':
    'launch-arbitrum-chain/configuration/core/config-smart-contract-size-limit.mdx',
  'launch-arbitrum-chain/chain-config/sequencer/chain-finality.mdx':
    'launch-arbitrum-chain/configuration/validation/arbitrum-chain-finality.mdx',
  'launch-arbitrum-chain/chain-config/sequencer/sequencer-timing-adjustments.mdx':
    'launch-arbitrum-chain/configuration/sequencer/config-sequencer-timing-adjustments.mdx',
  'launch-arbitrum-chain/chain-config/sequencer/timeboost.mdx':
    'launch-arbitrum-chain/configuration/sequencer/timeboost-for-arbitrum-chains.mdx',
  // The other half of the merge above.
  'launch-arbitrum-chain/chain-config/validation/assertion-control.mdx': {
    to: 'launch-arbitrum-chain/configuration/sequencer/batch-posting-assertion-control.mdx',
    merge: true,
  },
  'launch-arbitrum-chain/chain-config/validation/bold.mdx':
    'launch-arbitrum-chain/configuration/sequencer/bold-adoption-for-arbitrum-chains.mdx',
  'launch-arbitrum-chain/chain-config/validation/bond-and-validator.mdx':
    'launch-arbitrum-chain/configuration/validation/stake-and-validator-configurations.mdx',
  'launch-arbitrum-chain/chain-config/validation/challenge-period.mdx':
    'launch-arbitrum-chain/configuration/validation/customizable-challenge-period.mdx',
  'launch-arbitrum-chain/deploy/configure-node.mdx':
    'launch-arbitrum-chain/arbitrum-chain-sdk-preparing-node-config.mdx',
  'launch-arbitrum-chain/deploy/deploy-chain.mdx':
    'launch-arbitrum-chain/deploy/deploying-an-arbitrum-chain.mdx',
  'launch-arbitrum-chain/deploy/token-bridge.mdx':
    'launch-arbitrum-chain/deploy/deploying-token-bridge.mdx',
  // Upstream moved this out of extend-the-protocol in 1f9d652ef ("Moving da-api-integration-guide
  // to integrations/da-api-guide"); it was ported here before the move, under the older name. Body
  // similarity 0.994, so it is a rename, not a gap.
  'launch-arbitrum-chain/extend-the-protocol/da-api-guide.mdx':
    'launch-arbitrum-chain/integrations/da-api-integration-guide.mdx',
  // The rest of upstream's extend-the-protocol/ was ported into configuration/core/ under
  // `customize-` names; titles are identical in all three cases. `arbos` and `stf` are the how-to
  // pages that share a basename with the how-arbitrum-works concept pages, which is exactly what
  // the old bare-slug fallback mispaired them against.
  'launch-arbitrum-chain/extend-the-protocol/precompiles.mdx':
    'launch-arbitrum-chain/configuration/core/customize-precompile.mdx',
  'launch-arbitrum-chain/extend-the-protocol/arbos.mdx':
    'launch-arbitrum-chain/configuration/core/customize-arbos.mdx',
  'launch-arbitrum-chain/extend-the-protocol/stf.mdx':
    'launch-arbitrum-chain/configuration/core/customize-stf.mdx',
  'launch-arbitrum-chain/integrations/bridged-usdc.mdx':
    'launch-arbitrum-chain/integrations/bridged-usdc-standard.mdx',
  'launch-arbitrum-chain/integrations/infrastructure-providers.mdx':
    'launch-arbitrum-chain/third-party-integrations/third-party-providers.mdx',
  'launch-arbitrum-chain/migrate/between-raases.mdx':
    'launch-arbitrum-chain/migrate/migrate-between-raases.mdx',
  'launch-arbitrum-chain/migrate/from-another-stack.mdx':
    'launch-arbitrum-chain/migrate/migrate-from-another-stack.mdx',
  'launch-arbitrum-chain/operate/monitoring.mdx':
    'launch-arbitrum-chain/operate/monitoring-tools-and-considerations.mdx',
  'launch-arbitrum-chain/operate/ownership-and-access.mdx':
    'launch-arbitrum-chain/operate/ownership-access-control.mdx',
  'launch-arbitrum-chain/operate/post-launch-deployments.mdx':
    'launch-arbitrum-chain/operate/post-launch-contract-deployments.mdx',
  'launch-arbitrum-chain/overview/faq.mdx':
    'launch-arbitrum-chain/troubleshooting-building-arbitrum-chain.mdx',
  'launch-arbitrum-chain/overview/introduction.mdx':
    'launch-arbitrum-chain/overview/a-gentle-introduction.mdx',
  'launch-arbitrum-chain/overview/license.mdx': 'launch-arbitrum-chain/overview/aep-license.mdx',
  'launch-arbitrum-chain/overview/public-preview.mdx':
    'launch-arbitrum-chain/overview/public-preview-expectations.mdx',
  'launch-arbitrum-chain/quickstart/l3-rollup-from-scratch.mdx':
    'launch-arbitrum-chain/quickstart/deploy-your-first-rollup.mdx',
  'launch-arbitrum-chain/quickstart/l3-rollup-testnet.mdx':
    'launch-arbitrum-chain/quickstart/run-testnet-infrastructure-first-rollup.mdx',
  'launch-arbitrum-chain/quickstart/sdk-introduction.mdx':
    'launch-arbitrum-chain/overview/arbitrum-chain-sdk-introduction.mdx',
  // "Run a batch poster" in both trees, renamed on port. Distinct from the how-arbitrum-works
  // concept page also called batchposter, which is what the bare-slug fallback used to grab.
  'launch-arbitrum-chain/run-a-node/batch-poster.mdx': 'run-a-node/run-batch-poster.mdx',
  'launch-arbitrum-chain/run-a-node/high-availability-sequencer.mdx':
    'run-a-node/high-availability-sequencer-docs.mdx',
  'launch-arbitrum-chain/run-a-node/split-validator-node.mdx':
    'run-a-node/run-split-validator-node.mdx',
  'learn-more/faq.mdx': 'get-started/faq.mdx',
  'node-running/faq.mdx': 'run-a-node/faq.mdx',
};

/** The Tree B path a RENAME_MAP value points at, for either supported shape. */
function renameTarget(value) {
  return typeof value === 'string' ? value : value.to;
}

/**
 * Whether this Tree A path is allowed to share its Tree B counterpart with another Tree A path.
 *
 * Only a RENAME_MAP entry marked `merge: true` may, which is how a deliberate two-into-one port is
 * told apart from two pages accidentally colliding on the same target.
 */
export function isMergeRename(relA) {
  const value = RENAME_MAP[relA];
  return typeof value === 'object' && value.merge === true;
}

/** Reduce a path to a comparable slug: basename, no extension, no ordering prefix, alphanumeric only. */
export function normalizeSlug(filePath) {
  const base = filePath.split('/').pop() ?? '';
  return base
    .replace(/\.mdx?$/, '')
    .replace(/^_/, '')
    .replace(/^\d+-/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Rewrite a Tree A relative path onto Tree B's layout. Explicit renames win over section prefixes. */
export function mapSectionPath(relPath) {
  if (Object.hasOwn(RENAME_MAP, relPath)) return renameTarget(RENAME_MAP[relPath]);

  const keys = Object.keys(SECTION_MAP).sort((a, b) => b.length - a.length);
  for (const from of keys) {
    if (relPath === from || relPath.startsWith(`${from}/`)) {
      return `${SECTION_MAP[from]}${relPath.slice(from.length)}`;
    }
  }
  return relPath;
}

/**
 * Build a Tree B lookup index from its relative file paths (posix-separated).
 *
 * Keys on directory + normalized slug so pages that share a bare slug (`index`, `overview`, …) in
 * different directories can't clobber each other. A bare-slug index is also kept as a fallback for
 * genuine cross-directory moves that a directory-qualified key can't find — but only for slugs that
 * are unique across Tree B, so an ambiguous bare slug is never guessed at.
 */
export function buildTreeIndex(relPaths) {
  const byDirSlug = new Map();
  const bareSlugCounts = new Map();
  const bareSlug = new Map();

  for (const rel of relPaths) {
    const dir = rel.split('/').slice(0, -1).join('/');
    const slug = normalizeSlug(rel);
    byDirSlug.set(`${dir}\0${slug}`, rel);

    const count = (bareSlugCounts.get(slug) ?? 0) + 1;
    bareSlugCounts.set(slug, count);
    if (count === 1) bareSlug.set(slug, rel);
    else bareSlug.delete(slug);
  }

  return { byDirSlug, bareSlug };
}

/**
 * Key a Tree A path the way `buildTreeIndex` keys Tree B: onto Tree B's layout, then directory and
 * normalized slug.
 */
function lookupKeys(relA) {
  const mapped = mapSectionPath(relA);
  const dir = mapped.split('/').slice(0, -1).join('/');
  return { dirSlug: `${dir}\0${normalizeSlug(mapped)}`, slug: normalizeSlug(mapped) };
}

/**
 * Pair every Tree A path against Tree B at once, one Tree B file to at most one Tree A file.
 *
 * Deciding one path in isolation is not enough when **upstream** holds two different pages that
 * share a basename, which is why no single-path resolver is exported any more. Upstream has both a
 * concept page and a how-to page named
 * `arbos.mdx` (likewise `batchposter`/`batch-poster` and `stf`); only the concept pages were ported.
 * Resolved one at a time, the concept page paired correctly by directory while the how-to page fell
 * through to the bare-slug fallback and grabbed the *same* local file. The report then called three
 * ported pages GUTTED — `batchposter` at 0.12, `stf` at 0.20, `arbos` at 0.48 — for the sole reason
 * that it was measuring a how-to against a concept page, and hid three genuinely unported how-tos
 * behind those bogus ratios. Two wrong answers from one mispairing.
 *
 * So pairing happens in two passes over the whole tree:
 *   1. directory-qualified matches, which are certain, and which claim their Tree B file
 *   2. the bare-slug fallback for whatever is left, never onto a file pass 1 already claimed
 *
 * A cross-section move still pairs, because nothing else claimed its target. A second upstream page
 * with the same basename now correctly reports ABSENT instead of stealing the first one's match.
 *
 * **One Tree B file, one Tree A page, in both passes.** The claim rule is not a tie-breaker for the
 * fallback alone: two upstream pages can land on the same Tree B file through the directory match
 * too, once a rename points them there. The single exception is a deliberate two-into-one port,
 * which both sides declare with `merge: true` in RENAME_MAP. Without that flag the collision is
 * treated as accidental and the later page reports ABSENT, which is the honest answer: the drift
 * tool cannot tell on its own whether a second page's content survived inside the first one's.
 *
 * Both passes run in sorted order, so which page wins a contested file never depends on readdir.
 *
 * @param {{byDirSlug: Map<string,string>, bareSlug: Map<string,string>}} index From `buildTreeIndex`.
 * @param {string[]} relAPaths Tree A relative paths.
 * @returns {Map<string, string|null>} Tree A path to its Tree B counterpart, or null.
 */
export function pairTrees(index, relAPaths) {
  const paired = new Map();
  const claimed = new Set();
  const pending = [];
  const sorted = [...relAPaths].sort((x, y) => x.localeCompare(y));

  for (const relA of sorted) {
    const { dirSlug, slug } = lookupKeys(relA);
    const exact = index.byDirSlug.get(dirSlug);
    if (!exact) {
      pending.push({ relA, slug });
      continue;
    }
    if (claimed.has(exact) && !isMergeRename(relA)) {
      paired.set(relA, null);
      continue;
    }
    paired.set(relA, exact);
    claimed.add(exact);
  }

  for (const { relA, slug } of pending) {
    const candidate = index.bareSlug.get(slug);
    if (candidate && (!claimed.has(candidate) || isMergeRename(relA))) {
      paired.set(relA, candidate);
      claimed.add(candidate);
    } else {
      paired.set(relA, null);
    }
  }

  return paired;
}

/** Count body lines, excluding a leading YAML frontmatter block. */
export function bodyLineCount(source) {
  const lines = source.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines[0]?.trim() !== '---') return lines.length;
  const end = lines.indexOf('---', 1);
  if (end === -1) return lines.length;
  return lines.length - end - 1;
}
