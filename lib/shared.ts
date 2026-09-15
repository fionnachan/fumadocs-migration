import { localSiteUrl, resolveSiteUrl } from './site-url.mjs';

export const appName = 'Arbitrum docs';
/** The brand's X handle, for the `twitter:site` card tag on every docs page. */
export const socialHandle = '@arbitrum';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export { localSiteUrl };

export const gitConfig = {
  user: 'OffchainLabs',
  repo: 'Fumadocs-test',
  branch: 'main',
};

/**
 * The absolute origin this site is served from, for `metadataBase`, canonical URLs, and anything
 * else that must be absolute.
 *
 * The rule itself lives in `lib/site-url.mjs`, in plain JavaScript, because `next.config.mjs` has
 * to apply the same rule and cannot import TypeScript. That module's comment explains why the
 * split exists and why the config file is the copy that enforces. This is the app-facing name for
 * it, bound to `process.env`.
 *
 * Callers that want the failure at build time must call it at module scope, as `app/layout.tsx`
 * does. A call inside a request handler only fails that request, and by then the build is already
 * deployed, so `next.config.mjs` is the real gate.
 *
 * Deliberately imports nothing but the rule, so `app/sitemap.ts` and `app/robots.ts` can adopt it
 * without dragging `lib/source` (and the compiled collection) anywhere near a client bundle.
 */
export function getSiteUrl(): string {
  return resolveSiteUrl(process.env);
}
