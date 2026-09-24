// Single source of truth for internal doc redirects. Consumed by next.config.ts.
// Entries between the AUTO-GENERATED markers are maintained by `pnpm move-doc`.
import { legacyRedirects } from './redirects.legacy.ts';

/** The shape `next.config.ts` hands to Next; `redirects.legacy.ts` imports it as a type only. */
export type Redirect = { source: string; destination: string; permanent: boolean };

export const redirects: Redirect[] = [
  // AUTO-GENERATED REDIRECTS START
  {
    source: '/docs/launch-arbitrum-chain/run-a-node/run-batch-poster',
    destination: '/docs/run-a-node/run-batch-poster',
    permanent: true,
  },
  {
    source: '/docs/launch-arbitrum-chain/run-a-node/run-split-validator-node',
    destination: '/docs/run-a-node/run-split-validator-node',
    permanent: true,
  },
  {
    source: '/docs/launch-arbitrum-chain/run-a-node/high-availability-sequencer-docs',
    destination: '/docs/run-a-node/high-availability-sequencer-docs',
    permanent: true,
  },
  {
    source: '/docs/launch-arbitrum-chain/run-a-node',
    destination: '/docs/run-a-node',
    permanent: true,
  },
  // AUTO-GENERATED REDIRECTS END

  // Legacy docs.arbitrum.io URLs (root-level, pre-migration), hand-maintained in
  // redirects.legacy.ts. Listed last so a hand-written or move-doc entry above always wins.
  ...legacyRedirects,
];
