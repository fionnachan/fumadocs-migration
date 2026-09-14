import { createMDX } from 'fumadocs-mdx/next';

import { redirects } from './redirects.config.mjs';

/**
 * Fail a production build that has no `NEXT_PUBLIC_SITE_URL`.
 *
 * The rule itself lives in `getSiteUrl()` in lib/shared.ts, which throws on the same condition.
 * It is restated here because **that throw never runs during a build**: `pnpm build` uses
 * `--experimental-build-mode=compile` and `generateStaticParams` returns `[]` (see CLAUDE.md,
 * "Known trade-off"), so no page or layout module is ever evaluated at build time. Verified: a
 * build with `VERCEL_ENV=production` and the variable unset completed successfully with the helper
 * in place. Without this check the misconfiguration would surface only as a site-wide 500 on the
 * first request after promoting to production.
 *
 * `next.config.mjs` is the earliest thing the build does evaluate, which is what makes it the
 * enforcement point. Keep the two in sync; lib/shared.ts is the canonical statement of the rule.
 */
if (
  !process.env.NEXT_PUBLIC_SITE_URL &&
  (process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV) === 'production'
) {
  throw new Error(
    'NEXT_PUBLIC_SITE_URL is not set in a production build. Set it to the public origin of the ' +
      'site (for example https://docs.arbitrum.io) in the Vercel project environment variables. ' +
      'Without it every canonical and social image URL would be built pointing at ' +
      'http://localhost:3000. See lib/shared.ts, getSiteUrl().',
  );
}

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  devIndicators: false,
  async redirects() {
    return redirects;
  },
};

export default withMDX(config);
