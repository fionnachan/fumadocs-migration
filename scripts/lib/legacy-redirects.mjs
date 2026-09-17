/**
 * The hand-maintained overlay that decides where legacy docs.arbitrum.io URLs point.
 *
 * Legacy URLs were served at the site root (`/stylus/using-cli`); this site serves docs under
 * `/docs`. `redirects.legacy.mjs` carries the resulting 4,424 entries and is committed, permanent
 * and now **hand-maintained**: the generator that derived it read a sibling `arbitrum-docs`
 * checkout (its `vercel.json` for redirect sources and its `docs/` tree for canonical page URLs),
 * and that repo is archived. Adding a legacy redirect now means appending one
 * `{ source, destination, permanent }` object to `redirects.legacy.mjs` by hand, then proving the
 * destination with `pnpm redirects:check`, which resolves it against the router's own URL
 * inventory rather than against a guess at what is routable.
 *
 * What survives here are the two judgement maps and the page inventory that keeps them honest.
 * `MANUAL_DESTINATIONS` and `SECTION_LANDINGS` are read by `scripts/lib/legacy-destinations.mjs`,
 * which retargets them whenever `pnpm move-doc` moves a page one of them names, and by the tripwire
 * in `legacy-redirects.test.mjs`, which fails the suite the moment either names a page that is no
 * longer there.
 *
 * ## How the committed map was resolved
 *
 * Recorded because it explains where every one of those entries points, and because a hand-added
 * entry should follow the same order. Each legacy URL was resolved by the first rule that matched,
 * and a rule that could not decide declined rather than guessing: a redirect to a merely-plausible
 * page is worse than a 404, since it sends readers somewhere wrong and `redirects:check` cannot
 * catch it, because the destination exists.
 *
 *  1. `MANUAL_DESTINATIONS`: hand-verified against the upstream page's frontmatter title, so it
 *     beat everything.
 *  2. Self-URL: the legacy path names a live page here under `/docs`. This resolved nearly every
 *     canonical upstream URL, which had only ever needed the `/docs` prefix.
 *  3. `SECTION_RENAMES`: whole sections that moved wholesale.
 *  4. Exact frontmatter title: exactly one page here carried the upstream page's title, verbatim,
 *     and exactly one page upstream carried it. Ahead of the basename, because a title identifies a
 *     page and a basename only suggests one. This is what kept a `configuration/…` how-to from
 *     being answered with the `features/…/choose-…` page explaining why someone might want it.
 *  5. Unique basename: only when exactly one page here carried that slug *and* the basename was
 *     unique upstream too. Where the legacy path was doing the disambiguating, the basename could
 *     not, so it declined.
 *  6. `SECTION_LANDINGS`: the nearest live section landing, for a page this site never ported.
 *     Last on purpose, so it never masked a page that does exist here, and so it goes inert on its
 *     own the day that page lands.
 *
 * Anything no rule resolved was parked rather than pointed at a plausible page.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Legacy section -> this site's section: rule 3 of the resolution order above.
 *
 * Only renames where the whole section moved wholesale and the target section
 * exists. Deep restructures (launch-arbitrum-chain, build-decentralized-apps)
 * are deliberately absent: their pages moved individually, so a section-level
 * rename would produce confidently-wrong destinations.
 *
 * Kept as the record of which sections moved, and load-bearing for one test:
 * `legacy-destinations.test.mjs` pins the `move-doc` retargeter against this declaration, proving
 * it edits only inside the two `new Map([...])` literals and cannot wander into a neighbouring
 * array of URL-shaped strings.
 */
export const SECTION_RENAMES = [
  ['/run-arbitrum-node', '/run-a-node'],
  ['/node-running', '/run-a-node'],
  ['/for-devs', '/build-decentralized-apps'],
  ['/intro', '/get-started'],
  ['/learn-more', '/get-started'],
  ['/faqs', '/get-started'],
];

/**
 * Legacy destination -> this site's page, where no mechanical rule can pick the right one.
 *
 * Two situations land here. The basename fallback matches on basename, so when a how-to was
 * renamed on the way over it can only see a same-named concept page and sends the reader there
 * instead. And upstream has since restructured `launch-arbitrum-chain` into a `chain-config/…`
 * shape this site never adopted, so its redirect chains terminate at paths that exist upstream
 * and nowhere here — no prefix rule describes that, because the sections were re-cut, not renamed.
 *
 * Every entry was confirmed by comparing the upstream page's frontmatter title against this
 * site's candidates; where the titles are verbatim-identical that is noted as `=`. A value may
 * carry an `#anchor`; the page part must resolve or the build throws.
 */
export const MANUAL_DESTINATIONS = new Map([
  ['/get-started/overview', '/docs/get-started'],
  [
    '/launch-arbitrum-chain/extend-the-protocol/stf',
    '/docs/launch-arbitrum-chain/configuration/core/customize-stf',
  ],
  // = "How to customize your Arbitrum chain's precompiles", a how-to. The `features/advanced`
  // page is titled "Why choose to customize the precompiles on your Arbitrum chain" and answers a
  // different question, so it was the wrong half of the pair.
  [
    '/launch-arbitrum-chain/extend-the-protocol/precompiles',
    '/docs/launch-arbitrum-chain/configuration/core/customize-precompile',
  ],
  ['/launch-arbitrum-chain/run-a-node/batch-poster', '/docs/run-a-node/run-batch-poster'],

  // --- upstream `launch-arbitrum-chain/chain-config/*` -> this site's `configuration/*` ---
  // Upstream re-cut these sections; the leaf pages kept their content but not their path.
  [
    '/launch-arbitrum-chain/chain-config/batch-poster/enable-4844-blobs',
    '/docs/launch-arbitrum-chain/configuration/data-availability/enable-post-4844-blobs',
  ],
  [
    '/launch-arbitrum-chain/chain-config/batch-poster/fee-tuning',
    '/docs/launch-arbitrum-chain/configuration/sequencer/batch-poster-fee-tuning',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/aep-overview',
    '/docs/launch-arbitrum-chain/configuration/costs/aep-fee-router-introduction',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/aep-router-contracts',
    '/docs/launch-arbitrum-chain/configuration/costs/set-up-aep-fee-router',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/configure-native-mint-burn',
    '/docs/launch-arbitrum-chain/configuration/costs/configure-native-mint-burn-gas-token',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/custom-gas-token-anytrust',
    '/docs/launch-arbitrum-chain/configuration/costs/use-a-custom-gas-token-anytrust',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/custom-gas-token-rollup',
    '/docs/launch-arbitrum-chain/configuration/costs/use-a-custom-gas-token-rollup',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/dynamic-pricing',
    '/docs/launch-arbitrum-chain/configuration/costs/dynamic-pricing-for-arbitrum-chains',
  ],
  // Without this the basename sends chain gas-optimization to stylus/best-practices/gas-optimization.
  [
    '/launch-arbitrum-chain/chain-config/costs/gas-optimization',
    '/docs/launch-arbitrum-chain/configuration/costs/gas-optimization-tools',
  ],
  [
    '/launch-arbitrum-chain/chain-config/data-availability/dac-get-started',
    '/docs/launch-arbitrum-chain/configuration/data-availability/data-availability-committees/get-started',
  ],
  [
    '/launch-arbitrum-chain/chain-config/execution/smart-contract-size-limit',
    '/docs/launch-arbitrum-chain/configuration/core/config-smart-contract-size-limit',
  ],
  [
    '/launch-arbitrum-chain/chain-config/sequencer/chain-finality',
    '/docs/launch-arbitrum-chain/configuration/validation/arbitrum-chain-finality',
  ],
  // = "Timeboost for Arbitrum chains". Upstream records this destination both ways: one entry has
  // a doubled leading slash. Both keys are needed, because the doubled form never normalises to
  // the single form (it is rejected as malformed), and four sources arrive by the single form.
  [
    '/launch-arbitrum-chain/chain-config/sequencer/timeboost',
    '/docs/launch-arbitrum-chain/configuration/sequencer/timeboost-for-arbitrum-chains',
  ],
  [
    '//launch-arbitrum-chain/chain-config/sequencer/timeboost',
    '/docs/launch-arbitrum-chain/configuration/sequencer/timeboost-for-arbitrum-chains',
  ],
  [
    '/launch-arbitrum-chain/chain-config/validation/assertion-control',
    '/docs/launch-arbitrum-chain/configuration/sequencer/batch-posting-assertion-control',
  ],
  [
    '/launch-arbitrum-chain/chain-config/validation/bond-and-validator',
    '/docs/launch-arbitrum-chain/configuration/validation/stake-and-validator-configurations',
  ],
  [
    '/launch-arbitrum-chain/chain-config/validation/challenge-period',
    '/docs/launch-arbitrum-chain/configuration/validation/customizable-challenge-period',
  ],
  // `arbos` = "How to customize ArbOS on your Arbitrum chain", a how-to. Without this the basename
  // sends it to how-arbitrum-works/deep-dives/arbos, which is the ArbOS concept page.
  [
    '/launch-arbitrum-chain/extend-the-protocol/arbos',
    '/docs/launch-arbitrum-chain/configuration/core/customize-arbos',
  ],
  [
    '/launch-arbitrum-chain/extend-the-protocol/da-api-guide',
    '/docs/launch-arbitrum-chain/integrations/da-api-integration-guide',
  ],

  // --- upstream `configure-your-chain/*` (an earlier shape) still referenced by old entries ---
  [
    '/launch-arbitrum-chain/configure-your-chain/common/data-availability/data-availability-committees/deploy-a-das',
    '/docs/launch-arbitrum-chain/configuration/data-availability/data-availability-committees/deploy-das',
  ],
  [
    '/launch-arbitrum-chain/configure-your-chain/common/data-availability/data-availability-committees/deploy-a-mirror-das',
    '/docs/launch-arbitrum-chain/configuration/data-availability/data-availability-committees/deploy-mirror-das',
  ],

  // --- deploy / quickstart / operate. Titles are verbatim-identical across both sites. ---
  [
    '/launch-arbitrum-chain/deploy-an-arbitrum-chain/customize-deployment-configuration',
    '/docs/launch-arbitrum-chain/deploy/deploying-an-arbitrum-chain',
  ],
  // Upstream typo, kept verbatim so the lookup matches: "arbiturm".
  [
    '/launch-arbitrum-chain/deploy-an-arbitrum-chain/deploying-an-arbiturm-chain',
    '/docs/launch-arbitrum-chain/deploy/deploying-an-arbitrum-chain',
  ],
  // = "How to configure your Arbitrum chain's node using the Chain SDK"
  [
    '/launch-arbitrum-chain/deploy/configure-node',
    '/docs/launch-arbitrum-chain/arbitrum-chain-sdk-preparing-node-config',
  ],
  // = "How to deploy an Arbitrum chain using the Chain SDK"
  [
    '/launch-arbitrum-chain/deploy/deploy-chain',
    '/docs/launch-arbitrum-chain/deploy/deploying-an-arbitrum-chain',
  ],
  [
    '/launch-arbitrum-chain/deploy/token-bridge',
    '/docs/launch-arbitrum-chain/deploy/deploying-token-bridge',
  ],
  // = "Run an L3 rollup from scratch"
  [
    '/launch-arbitrum-chain/quickstart/l3-rollup-from-scratch',
    '/docs/launch-arbitrum-chain/quickstart/deploy-your-first-rollup',
  ],
  // = "Run testnet infrastructure on your first rollup (product-level testnet)"
  [
    '/launch-arbitrum-chain/quickstart/l3-rollup-testnet',
    '/docs/launch-arbitrum-chain/quickstart/run-testnet-infrastructure-first-rollup',
  ],
  [
    '/launch-arbitrum-chain/quickstart/sdk-introduction',
    '/docs/launch-arbitrum-chain/overview/arbitrum-chain-sdk-introduction',
  ],
  [
    '/launch-arbitrum-chain/operate/monitoring',
    '/docs/launch-arbitrum-chain/operate/monitoring-tools-and-considerations',
  ],
  // = "Ownership structure and access control"
  [
    '/launch-arbitrum-chain/operate/ownership-and-access',
    '/docs/launch-arbitrum-chain/operate/ownership-access-control',
  ],
  [
    '/launch-arbitrum-chain/operate/post-launch-deployments',
    '/docs/launch-arbitrum-chain/operate/post-launch-contract-deployments',
  ],
  [
    '/launch-arbitrum-chain/migrate/between-raases',
    '/docs/launch-arbitrum-chain/migrate/migrate-between-raases',
  ],
  [
    '/launch-arbitrum-chain/migrate/from-another-stack',
    '/docs/launch-arbitrum-chain/migrate/migrate-from-another-stack',
  ],
  [
    '/launch-arbitrum-chain/integrations/bridged-usdc',
    '/docs/launch-arbitrum-chain/integrations/bridged-usdc-standard',
  ],
  [
    '/launch-arbitrum-chain/integrations/infrastructure-providers',
    '/docs/launch-arbitrum-chain/third-party-integrations/third-party-providers',
  ],
  // = "Overview of Arbitrum chains". overview/index.mdx is a different page, titled "Concepts".
  [
    '/launch-arbitrum-chain/overview/introduction',
    '/docs/launch-arbitrum-chain/overview/a-gentle-introduction',
  ],
  ['/launch-arbitrum-chain/overview/license', '/docs/launch-arbitrum-chain/overview/aep-license'],
  [
    '/launch-arbitrum-chain/overview/public-preview',
    '/docs/launch-arbitrum-chain/overview/public-preview-expectations',
  ],
  [
    '/launch-arbitrum-chain/overview/faq',
    '/docs/launch-arbitrum-chain/troubleshooting-building-arbitrum-chain',
  ],
  // The node how-tos live under run-a-node here, not under launch-arbitrum-chain.
  [
    '/launch-arbitrum-chain/run-a-node/high-availability-sequencer',
    '/docs/run-a-node/high-availability-sequencer-docs',
  ],
  [
    '/launch-arbitrum-chain/run-a-node/split-validator-node',
    '/docs/run-a-node/run-split-validator-node',
  ],
  [
    '/run-arbitrum-node/data-availability-committees/get-started',
    '/docs/launch-arbitrum-chain/configuration/data-availability/data-availability-committees/get-started',
  ],
  // Upstream records this as a path but wrote an absolute URL with a stray leading slash. The page
  // it names exists here, so serve ours rather than sending readers off-site.
  [
    '/https://docs.arbitrum.foundation/calculate-aep-fees',
    '/docs/launch-arbitrum-chain/configuration/costs/calculate-aep-fees',
  ],

  // --- outside launch-arbitrum-chain ---
  [
    '/build-decentralized-apps/token-bridging/overview',
    '/docs/arbitrum-essentials/bridging/overview',
  ],
  [
    '/build-decentralized-apps/precompiles/reference#arbsys',
    '/docs/arbitrum-essentials/precompiles/reference#arbsys',
  ],
  [
    '/how-arbitrum-works/deep-dives/arbos#stylus-specific-differences',
    '/docs/how-arbitrum-works/deep-dives/arbos#stylus-specific-differences',
  ],
  [
    '/how-arbitrum-works/deep-dives/gas-and-fees#parent-chain-gas-pricing',
    '/docs/how-arbitrum-works/deep-dives/gas-and-fees#parent-chain-gas-pricing',
  ],
  // The gentle intro was folded into the STF page here; see the GUTTED entry in `pnpm drift`.
  ['/how-arbitrum-works/deep-dives/stf-gentle-intro', '/docs/how-arbitrum-works/deep-dives/stf'],
  ['/for-devs/contribute', '/docs/contribute'],
  ['/stylus/cli-tools-overview', '/docs/stylus/cli-tools/overview'],
  // = "How to verify Stylus contracts". The Arbiscan how-to is a different page.
  ['/stylus/how-tos/verifying-contracts', '/docs/stylus/cli-tools/verify-contracts'],
  // Upstream has no /stylus/overview page either; the section landing is the honest target.
  ['/stylus/overview', '/docs/stylus'],
  // `/faqs/protocol-faqs` does not exist upstream — these three anchors 404 on the live site
  // today. Each question has a page here that actually answers it, so route to that page.
  [
    '/faqs/protocol-faqs#q-rollup-vs-anytrust',
    '/docs/how-arbitrum-works/deep-dives/anytrust-protocol',
  ],
  ['/faqs/protocol-faqs#q-seq-vs-val', '/docs/how-arbitrum-works/deep-dives/sequencer'],
  ['/faqs/protocol-faqs#q-dispute-reorg', '/docs/how-arbitrum-works/bold/gentle-introduction'],

  // --- canonical upstream URLs the basename rule cannot see ---
  // Upstream's `id` frontmatter renames the last URL segment away from the file name, so the URL
  // upstream serves shares no basename with the file this site ported. Nothing mechanical can
  // bridge that; the page is the same page in each pair.
  // = "Supra, price feed oracle"
  ['/for-devs/oracles/supra/supras-price-feed', '/docs/oracles/supra/use-supras-price-feed-oracle'],
  // = "Supra, VRF"
  ['/for-devs/oracles/supra/supras-vrf', '/docs/oracles/supra/use-supras-vrf'],
  // = "Oracles providers", a provider index. `/docs/oracles` is that index here; the basename
  // `oracles-content-map` exists nowhere in this tree because the nav moved into meta.json.
  ['/for-devs/oracles/oracles-content-map', '/docs/oracles'],
  // = "Contribute third-party docs". The basename alone is ambiguous with `/docs/contribute`,
  // which is the general "Contribute docs" page, so the fallback rightly declined.
  ['/for-devs/third-party-docs/contribute', '/docs/third-party-docs/contribute'],
]);

/**
 * Last resort: the nearest live section landing, for a canonical upstream URL whose page this site
 * has not ported.
 *
 * These are not equivalences and must never be treated as such. Each names a page that exists
 * upstream and nowhere here. Almost all were added upstream after the port window closed, so
 * `pnpm drift` reports them as work still to do. Sending the reader to the section they were
 * heading for is better than a 404 at cutover, and it is the same judgement already recorded for
 * `/stylus/overview` in `MANUAL_DESTINATIONS`.
 *
 * Consulted only after every mechanical rule has declined, and *after* the self-URL rule in
 * particular. So the day one of these pages is ported, the self-URL rule matches first and the
 * entry below goes inert on its own rather than pinning readers to a landing page forever.
 *
 * Each comment records the upstream frontmatter title and the date the page appeared upstream.
 */
export const SECTION_LANDINGS = new Map([
  // "BoLD FAQ", upstream 2026-08-26.
  ['/how-arbitrum-works/bold/bold-faq', '/docs/how-arbitrum-works/bold'],
  // "Batch Poster", upstream 2026-06-05. Batch-poster configuration lives under this landing here.
  [
    '/launch-arbitrum-chain/chain-config/batch-poster/config-batch-poster',
    '/docs/launch-arbitrum-chain/configuration/sequencer',
  ],
  // "Sequencer configuration reference", upstream 2026-08-17.
  [
    '/launch-arbitrum-chain/chain-config/sequencer/sequencer-config-reference',
    '/docs/launch-arbitrum-chain/configuration/sequencer',
  ],
  // "Tune parent chain data fee pricing", upstream 2026-08-20.
  [
    '/launch-arbitrum-chain/chain-config/costs/parent-chain-data-fee-pricing',
    '/docs/launch-arbitrum-chain/configuration/costs',
  ],
  // "Priority fees collection", upstream 2026-08-04.
  [
    '/launch-arbitrum-chain/chain-config/costs/priority-fees',
    '/docs/launch-arbitrum-chain/configuration/costs',
  ],
  // "Configure a test Arbitrum chain", upstream 2026-08-03.
  [
    '/launch-arbitrum-chain/chain-config/validation/test-chain-configuration',
    '/docs/launch-arbitrum-chain/configuration/validation',
  ],
  // "Token bridge troubleshooting", upstream 2026-07-29.
  [
    '/launch-arbitrum-chain/deploy/token-bridge-troubleshooting',
    '/docs/launch-arbitrum-chain/deploy',
  ],
  // "Common error messages", upstream 2026-08-03.
  ['/launch-arbitrum-chain/operate/error-index', '/docs/launch-arbitrum-chain/operate'],
  // "Sequencer troubleshooting", upstream 2026-08-17.
  [
    '/launch-arbitrum-chain/operate/sequencer-troubleshooting',
    '/docs/launch-arbitrum-chain/operate',
  ],
  // "ArbOS 61 Elara", upstream 2026-07-16. The releases index here is `overview`, not an `index`.
  ['/run-arbitrum-node/arbos-releases/arbos61', '/docs/run-a-node/arbos-releases/overview'],
  // "Sequencer", a Docusaurus <Card> grid. `pnpm drift` records it as a standing non-item: the
  // sequencer nav lives in meta.json here, so the section landing is all there is to point at.
  ['/node-running/sequencer-content-map', '/docs/run-a-node'],
]);

/**
 * Every routable doc URL on this site, derived from the content tree, keyed by lowercased URL.
 *
 * The legacy corpus has casing drift (`/sdk/assetbridger` next to `/sdk/assetBridger`), and this
 * tree has mixed-case directories (`oracles/DIA`, `third-party-docs/Circle`). Matching
 * case-sensitively would report a destination that exists as "not in tree". The map value is the
 * real casing, which is what must be emitted — a redirect to the wrong case still 404s.
 */
export function collectValidUrls(contentDir) {
  const urls = new Map();
  for (const { url } of collectLocalPages(contentDir)) {
    const key = url.toLowerCase();
    const clash = urls.get(key);
    if (clash && clash !== url) {
      throw new Error(
        `legacy-redirects: two pages differ only by case (${clash} vs ${url}); ` +
          `case-insensitive matching cannot pick between them.`,
      );
    }
    urls.set(key, url);
  }
  return urls;
}

/**
 * Every routable page on this site as `{ url, file }`.
 *
 * The same walk `collectValidUrls` is built from, exported separately because the tripwire test
 * wants the file paths as well as the URLs.
 */
export function collectLocalPages(contentDir) {
  const pages = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}/${entry}`);
      } else if (entry.endsWith('.mdx') && !entry.startsWith('_')) {
        const base = entry.slice(0, -'.mdx'.length);
        pages.push({
          url: base === 'index' ? `/docs${prefix}` : `/docs${prefix}/${base}`,
          file: full,
        });
      }
    }
  };
  walk(contentDir, '');
  return pages;
}

/** Resolve a URL to its real casing on this site, or undefined when no page serves it. */
export const resolveUrl = (valid, url) => valid.get(url.toLowerCase());

/** A destination that leaves this site, which no page inventory can be expected to resolve. */
export const isAbsolute = (value) => /^https?:\/\//.test(value);
