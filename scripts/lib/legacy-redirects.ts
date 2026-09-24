/**
 * The hand-maintained overlay that decides where legacy docs.arbitrum.io URLs point.
 *
 * Legacy URLs were served at the site root (`/stylus/using-cli`); this site serves docs under
 * `/docs`. `redirects.legacy.ts` carries the resulting 853 entries (across 4,425 lines) and is
 * committed, permanent and now **hand-maintained**: the generator that derived it read a sibling
 * `arbitrum-docs` checkout (its `vercel.json` for redirect sources and its `docs/` tree for
 * canonical page URLs), and that repo is archived. Adding a legacy redirect now means appending
 * one `{ source, destination, permanent }` object to `redirects.legacy.ts` by hand, then proving
 * the destination with `pnpm redirects:check`, which resolves it against the router's own URL
 * inventory rather than against a guess at what is routable.
 *
 * What survives here are the two judgement maps and the page inventory that keeps them honest.
 * `MANUAL_DESTINATIONS` and `SECTION_LANDINGS` are read by `scripts/lib/legacy-destinations.ts`,
 * which retargets them whenever `pnpm move-doc` moves a page one of them names, and by the tripwire
 * in `legacy-redirects.test.ts`, which fails the suite the moment either names a page that is no
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
 *     Last on purpose, so it never masked a page that does exist here.
 *
 * Anything no rule resolved was parked rather than pointed at a plausible page.
 *
 * ## Why rule 6 does not expire on its own (FS-2748)
 *
 * Rule 6 was written to be self-correcting: re-resolve the legacy URL once the page is ported and
 * rule 2 matches first, so the landing entry stops being consulted. That only ever worked on a
 * re-resolution, and there has never been one. Nine `SECTION_LANDINGS` entries were already wrong
 * in the commit that introduced them: all nine pages were ported on 2026-09-11 and all nine were in
 * the tree at `27f7660`, the commit that seeded `redirects.legacy.ts` on 2026-09-15, where rule 2
 * would have claimed them had the generator been re-run against that tree rather than the older one
 * its output was computed from. FS-2706 then deleted the generator, so no run will ever happen and
 * a committed landing destination is now permanent by construction.
 *
 * Those nine sit in `MANUAL_DESTINATIONS` now. `UPSTREAM_TITLES` below is the replacement for the
 * self-correction: it makes rule 4 a test that runs on every `pnpm test`, rather than a property of
 * a program nobody runs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { splitFrontmatter } from './partials.ts';

/**
 * Legacy section -> this site's section: rule 3 of the resolution order above.
 *
 * Only renames where the whole section moved wholesale and the target section
 * exists. Deep restructures (launch-arbitrum-chain, build-decentralized-apps)
 * are deliberately absent: their pages moved individually, so a section-level
 * rename would produce confidently-wrong destinations.
 *
 * Kept as the record of which sections moved, and load-bearing for one test:
 * `legacy-destinations.test.ts` pins the `move-doc` retargeter against this declaration, proving
 * it edits only inside the two `new Map([...])` literals and cannot wander into a neighbouring
 * array of URL-shaped strings.
 */
export const SECTION_RENAMES: ReadonlyArray<readonly [from: string, to: string]> = [
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
  // The gentle intro was folded into the STF page here; the upstream comparison recorded that as a
  // GUTTED pair before it was retired (FS-2706).
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

  // --- rule 6 claimed these while the page already existed here (FS-2748) ---
  // Each of these nine was a `SECTION_LANDINGS` entry: upstream had the page, this site was
  // recorded as not having it, and the legacy URL was pointed at the nearest section landing. All
  // nine were ported on 2026-09-11, carrying the upstream title verbatim and the same basename, so
  // all nine were already in the tree when the map was committed four days later, and each went on
  // answering a reader who asked for the page with a list of links to the section holding it.
  // They belong here rather than in `SECTION_LANDINGS`, which is defined as pages this site has not
  // ported. Rules 2 and 3 would reach the same destinations unaided, but keeping the entries is
  // what makes `move-doc` retarget them, and what makes it print the note that
  // `redirects.legacy.ts` names these pages too.
  ['/how-arbitrum-works/bold/bold-faq', '/docs/how-arbitrum-works/bold/bold-faq'],
  [
    '/launch-arbitrum-chain/chain-config/sequencer/sequencer-config-reference',
    '/docs/launch-arbitrum-chain/configuration/sequencer/sequencer-config-reference',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/parent-chain-data-fee-pricing',
    '/docs/launch-arbitrum-chain/configuration/costs/parent-chain-data-fee-pricing',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/priority-fees',
    '/docs/launch-arbitrum-chain/configuration/costs/priority-fees',
  ],
  [
    '/launch-arbitrum-chain/chain-config/validation/test-chain-configuration',
    '/docs/launch-arbitrum-chain/configuration/validation/test-chain-configuration',
  ],
  [
    '/launch-arbitrum-chain/deploy/token-bridge-troubleshooting',
    '/docs/launch-arbitrum-chain/deploy/token-bridge-troubleshooting',
  ],
  ['/launch-arbitrum-chain/operate/error-index', '/docs/launch-arbitrum-chain/operate/error-index'],
  [
    '/launch-arbitrum-chain/operate/sequencer-troubleshooting',
    '/docs/launch-arbitrum-chain/operate/sequencer-troubleshooting',
  ],
  // The only one of the nine the `/docs` prefix alone would not have reached: the section was
  // renamed as well (`/run-arbitrum-node` -> `/run-a-node`, rule 3).
  ['/run-arbitrum-node/arbos-releases/arbos61', '/docs/run-a-node/arbos-releases/arbos61'],
]);

/**
 * Last resort: the nearest live section landing, for a canonical upstream URL whose page this site
 * has not ported.
 *
 * These are not equivalences and must never be treated as such. Each names a page that exists
 * upstream and nowhere here, and the two are here for different reasons: `config-batch-poster` was
 * added upstream after the port window closed, so the upstream comparison reported it as work still
 * to do before it was retired (FS-2706), while `sequencer-content-map` is a navigation page with no
 * equivalent here by design, which that comparison recorded as a standing non-item. Each entry's own
 * comment says which. Sending the reader to the section they were heading for is better than a 404
 * at cutover, and it is the same judgement already recorded for `/stylus/overview` in
 * `MANUAL_DESTINATIONS`.
 *
 * Consulted only after every mechanical rule has declined, and *after* the self-URL rule in
 * particular, so an entry here never masks a page that exists.
 *
 * **An entry here does not expire on its own.** It was meant to: re-resolving the legacy URL once
 * the page landed would have let rule 2 match first. But that needed a run of the generator, and
 * the generator was deleted in FS-2706, leaving `redirects.legacy.ts` a committed file that
 * nothing recomputes. Nine entries were wrong the day they were committed for want of that one
 * re-run (FS-2748), each sending a reader who asked for a page here to a list of links. Porting a
 * page named here is therefore a two-file edit: move its entry into `MANUAL_DESTINATIONS`
 * retargeted at the page, and retarget the matching `redirects.legacy.ts` entry. `UPSTREAM_TITLES`
 * below is what fails the suite if you forget.
 *
 * Each entry's comment records what is known about the upstream page, including the date it appeared
 * there where that is known; the upstream title is data, in `UPSTREAM_TITLES`.
 */
export const SECTION_LANDINGS = new Map([
  // Upstream 2026-06-05. Batch-poster configuration lives under this landing here.
  [
    '/launch-arbitrum-chain/chain-config/batch-poster/config-batch-poster',
    '/docs/launch-arbitrum-chain/configuration/sequencer',
  ],
  // A Docusaurus <Card> grid. The upstream comparison recorded it as a standing non-item before it
  // was retired (FS-2706): the sequencer nav lives in meta.json here, so the section landing is all
  // there is to point at.
  ['/node-running/sequencer-content-map', '/docs/run-a-node'],
]);

/**
 * The upstream frontmatter title behind a legacy source, for every entry in the two maps above
 * whose title was verified against upstream while that repo was still readable.
 *
 * Data, not prose, so `legacy-redirects.test.ts` can enforce rule 4 continuously: if exactly one
 * page here carries the title verbatim, the entry's destination has to be that page. That is the
 * rule that decides these entries in the first place, and until FS-2748 nothing checked it after
 * the fact. `redirects:check` never could, because the destination it was checking, a section
 * landing, exists.
 *
 * Keyed by legacy source rather than by title, because a source is unique across both maps and a
 * title need not be. An entry whose title matches no page today is not an error: the rule is
 * vacuous until the page lands, which is exactly when it should start to bite.
 *
 * Titles are recorded only where upstream was actually consulted. An unlisted source is not a
 * claim that it has no title, it is a claim that nobody verified one, and inventing a plausible
 * title here would turn a test into a guess.
 *
 * **A title match is evidence, not proof, and deleting an entry here is a supported answer.** Two of
 * these titles are short generic nouns, "Batch Poster" and "Sequencer". A page that takes such a
 * title for reasons of its own is not thereby the port of the upstream page, and retargeting the
 * destination at it would write the plausible-but-wrong redirect the resolution order exists to
 * avoid. So when the test fires and the page only shares the title, delete that source's entry from
 * this map with a comment saying why, and leave the destination where it is. Nothing requires a map
 * entry to have a recorded title: the map keeps working and only the claim nobody can verify any
 * more goes away. Retarget only when the page really is the port.
 */
export const UPSTREAM_TITLES = new Map([
  // Still in SECTION_LANDINGS: no page here carries either title, or either basename.
  ['/launch-arbitrum-chain/chain-config/batch-poster/config-batch-poster', 'Batch Poster'],
  ['/node-running/sequencer-content-map', 'Sequencer'],

  // The nine FS-2748 retargeted out of SECTION_LANDINGS.
  ['/how-arbitrum-works/bold/bold-faq', 'BoLD FAQ'],
  [
    '/launch-arbitrum-chain/chain-config/sequencer/sequencer-config-reference',
    'Sequencer configuration reference',
  ],
  [
    '/launch-arbitrum-chain/chain-config/costs/parent-chain-data-fee-pricing',
    'Tune parent chain data fee pricing',
  ],
  ['/launch-arbitrum-chain/chain-config/costs/priority-fees', 'Priority fees collection'],
  [
    '/launch-arbitrum-chain/chain-config/validation/test-chain-configuration',
    'Configure a test Arbitrum chain',
  ],
  ['/launch-arbitrum-chain/deploy/token-bridge-troubleshooting', 'Token bridge troubleshooting'],
  ['/launch-arbitrum-chain/operate/error-index', 'Common error messages'],
  ['/launch-arbitrum-chain/operate/sequencer-troubleshooting', 'Sequencer troubleshooting'],
  ['/run-arbitrum-node/arbos-releases/arbos61', 'ArbOS 61 Elara'],

  // The MANUAL_DESTINATIONS entries whose comments already recorded a verbatim-identical title.
  // All of them already name the page carrying it; listing them is what keeps that true.
  [
    '/launch-arbitrum-chain/extend-the-protocol/precompiles',
    "How to customize your Arbitrum chain's precompiles",
  ],
  [
    '/launch-arbitrum-chain/extend-the-protocol/arbos',
    'How to customize ArbOS on your Arbitrum chain',
  ],
  ['/launch-arbitrum-chain/chain-config/sequencer/timeboost', 'Timeboost for Arbitrum chains'],
  ['//launch-arbitrum-chain/chain-config/sequencer/timeboost', 'Timeboost for Arbitrum chains'],
  [
    '/launch-arbitrum-chain/deploy/configure-node',
    "How to configure your Arbitrum chain's node using the Chain SDK",
  ],
  [
    '/launch-arbitrum-chain/deploy/deploy-chain',
    'How to deploy an Arbitrum chain using the Chain SDK',
  ],
  ['/launch-arbitrum-chain/quickstart/l3-rollup-from-scratch', 'Run an L3 rollup from scratch'],
  [
    '/launch-arbitrum-chain/quickstart/l3-rollup-testnet',
    'Run testnet infrastructure on your first rollup (product-level testnet)',
  ],
  ['/launch-arbitrum-chain/operate/ownership-and-access', 'Ownership structure and access control'],
  ['/launch-arbitrum-chain/overview/introduction', 'Overview of Arbitrum chains'],
  ['/stylus/how-tos/verifying-contracts', 'How to verify Stylus contracts'],
  ['/for-devs/oracles/supra/supras-price-feed', 'Supra, price feed oracle'],
  ['/for-devs/oracles/supra/supras-vrf', 'Supra, VRF'],
  // No page here carries this title: `/docs/oracles` is titled "Oracles". The entry points at the
  // provider index anyway, which is what the upstream page was.
  ['/for-devs/oracles/oracles-content-map', 'Oracles providers'],
  ['/for-devs/third-party-docs/contribute', 'Contribute third-party docs'],
]);

/**
 * Every routable doc URL on this site, derived from the content tree, keyed by lowercased URL.
 *
 * The legacy corpus has casing drift (`/sdk/assetbridger` next to `/sdk/assetBridger`), and this
 * tree has mixed-case directories (`oracles/DIA`, `third-party-docs/Circle`). Matching
 * case-sensitively would report a destination that exists as "not in tree". The map value is the
 * real casing, which is what must be emitted — a redirect to the wrong case still 404s.
 */
export function collectValidUrls(contentDir: string): Map<string, string> {
  const urls = new Map<string, string>();
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
 * Every routable page on this site grouped by its exact frontmatter `title`, as `title -> URL[]`.
 *
 * Rule 4 of the resolution order reads this: a legacy URL resolves to the local page carrying the
 * upstream title verbatim, and declines when two pages share it, because there the title cannot
 * disambiguate. The array is what lets the caller tell those two cases apart.
 *
 * Titles come from `splitFrontmatter`, the repo's one frontmatter-title reader, rather than a
 * second regex written here. It strips the surrounding quotes, which matters: this tree writes
 * `title: 'BoLD FAQ'` and `title: Sequencer configuration reference` in roughly equal measure, and
 * a reader that kept the quotes would match neither form against the other.
 */
export function collectPagesByTitle(contentDir: string): Map<string, string[]> {
  const byTitle = new Map<string, string[]>();
  for (const { url, file } of collectLocalPages(contentDir)) {
    const { fm } = splitFrontmatter(readFileSync(file, 'utf8'));
    if (!fm?.title) continue;
    const urls = byTitle.get(fm.title);
    if (urls) urls.push(url);
    else byTitle.set(fm.title, [url]);
  }
  return byTitle;
}

/** One routable page: its site URL and the `.mdx` file behind it. */
export interface LocalPage {
  url: string;
  file: string;
}

/**
 * Every routable page on this site as `{ url, file }`.
 *
 * The walk `collectValidUrls` is built from, and exported because `collectPagesByTitle` needs the
 * file behind each URL to read its frontmatter. One walk serves both, so the URL a title resolves
 * to and the URL the tripwire resolves against can never come from different inventories.
 */
export function collectLocalPages(contentDir: string): LocalPage[] {
  const pages: LocalPage[] = [];
  const walk = (dir: string, prefix: string): void => {
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
export const resolveUrl = (valid: ReadonlyMap<string, string>, url: string): string | undefined =>
  valid.get(url.toLowerCase());

/** A destination that leaves this site, which no page inventory can be expected to resolve. */
export const isAbsolute = (value: string): boolean => /^https?:\/\//.test(value);
