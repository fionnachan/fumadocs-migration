import { createMDX } from 'fumadocs-mdx/next';

import { resolveSiteUrl } from './lib/site-url.mjs';
import { redirects } from './redirects.config.mjs';

/**
 * Fail a production build that has no usable `NEXT_PUBLIC_SITE_URL`.
 *
 * The rule lives in `lib/site-url.mjs` and `getSiteUrl()` in lib/shared.ts applies the same one.
 * `next.config.mjs` is the earliest thing the build evaluates, which is what makes it the
 * enforcement point that always fires. Without this call the misconfiguration would surface as a
 * site-wide 500 on the first request after promoting to production.
 *
 * Until FS-2689 this was the *only* check that could fire, because `pnpm build` used
 * `--experimental-build-mode=compile`, so no page or layout module was evaluated at build time at
 * all. Verified at the time: a build with `VERCEL_ENV=production` and the variable unset completed
 * successfully with only the helper in place. That flag is gone and 703 routes now prerender, so the
 * root layout's module scope runs at build and would throw as well. This check still earns its
 * keep: the docs route itself remains dynamic (see CLAUDE.md, "Known trade-off"), so it covers a
 * build whose prerendered routes happen not to reach `getSiteUrl()`.
 *
 * It imports the rule rather than restating it, so the copy that enforces is the copy the tests
 * cover. The return value is deliberately discarded; the throw is the whole point.
 */
resolveSiteUrl(process.env);

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
