import { createMDX } from 'fumadocs-mdx/next';

import { resolveSiteUrl } from './lib/site-url.mjs';
import { redirects } from './redirects.config.mjs';

/**
 * Fail a production build that has no usable `NEXT_PUBLIC_SITE_URL`.
 *
 * The rule lives in `lib/site-url.mjs` and `getSiteUrl()` in lib/shared.ts applies the same one, but
 * **that throw never runs during a build**: `pnpm build` uses `--experimental-build-mode=compile`
 * and `generateStaticParams` returns `[]` (see CLAUDE.md, "Known trade-off"), so no page or layout
 * module is ever evaluated at build time. Verified: a build with `VERCEL_ENV=production` and the
 * variable unset completed successfully with only the helper in place. Without this call the
 * misconfiguration would surface as a site-wide 500 on the first request after promoting to
 * production.
 *
 * `next.config.mjs` is the earliest thing the build does evaluate, which is what makes it the
 * enforcement point. It imports the rule rather than restating it, so the copy that enforces is the
 * copy the tests cover. The return value is deliberately discarded; the throw is the whole point.
 */
resolveSiteUrl(process.env);

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  devIndicators: false,
  /**
   * `fumadocs-twoslash` resolves type information by running the real TypeScript compiler, and from
   * v4 that is the native (Go) TypeScript 7 binary rather than a bundled JavaScript copy. Bundling
   * `typescript` into the server output would detach it from the platform binary it shells out to,
   * so Fumadocs requires it to stay external. Only MDX compilation touches it, so nothing ships to
   * the browser either way.
   */
  serverExternalPackages: ['typescript'],
  async redirects() {
    return redirects;
  },
};

export default withMDX(config);
