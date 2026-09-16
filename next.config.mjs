import { createMDX } from 'fumadocs-mdx/next';

import { resolveSiteUrl } from './lib/site-url.mjs';
import { redirects } from './redirects.config.mjs';

/**
 * Fail a production build that has no usable `NEXT_PUBLIC_SITE_URL`.
 *
 * The rule lives in `lib/site-url.mjs` and `getSiteUrl()` in lib/shared.ts applies the same one.
 * `next.config.mjs` is the earliest thing a build evaluates, which makes it the check that always
 * fires, including for a build whose prerendered routes never reach `getSiteUrl()` (the docs route
 * is dynamic). Without it the misconfiguration surfaces as a site-wide 500 on the first request
 * after promoting to production. It imports the rule rather than restating it, so the copy that
 * enforces is the copy the tests cover. The return value is discarded; the throw is the point.
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
