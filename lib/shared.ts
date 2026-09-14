export const appName = 'Arbitrum docs';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'OffchainLabs',
  repo: 'Fumadocs-test',
  branch: 'main',
};

/** Used whenever the site URL is not configured and we are not building for production. */
export const localSiteUrl = 'http://localhost:3000';

/**
 * The absolute origin this site is served from, for `metadataBase`, canonical URLs, and anything
 * else that must be absolute.
 *
 * **This throws rather than guessing, and that is the point.** `NEXT_PUBLIC_SITE_URL` is inlined
 * at build time, so a build that runs without it bakes the localhost fallback into every canonical
 * and social image URL in the deployed output. Those pages then tell crawlers that the canonical
 * copy of each page lives on localhost, which is worse than emitting no canonical at all, and
 * nothing about the running site reveals the mistake. Failing the production build is the only
 * point where it is still cheap to fix.
 *
 * Outside production the localhost fallback is correct and convenient: `pnpm dev`, `pnpm build`
 * on a laptop, CI, and preview deployments all work with nothing configured.
 *
 * Callers that want this enforced at build time must call it at module scope, as `app/layout.tsx`
 * does. A call inside a request handler only fails that request.
 *
 * Deliberately a plain function with no imports, so `app/sitemap.ts` and `app/robots.ts` can adopt
 * it without dragging `lib/source` (and the compiled collection) anywhere near a client bundle.
 */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured;

  // `VERCEL_ENV` is server-side and always present in a Vercel build. `NEXT_PUBLIC_VERCEL_ENV` is
  // its build-inlined twin, which exists only when the project exposes system environment
  // variables, so both are consulted and neither is required.
  const deploymentEnv = process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV;

  if (deploymentEnv === 'production') {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL is not set in a production build. Set it to the public origin of the ' +
        'site (for example https://docs.arbitrum.io) in the Vercel project environment variables. ' +
        'Without it every canonical and social image URL would be built pointing at ' +
        `${localSiteUrl}.`,
    );
  }

  return localSiteUrl;
}
