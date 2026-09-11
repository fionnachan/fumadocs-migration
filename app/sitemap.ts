import type { MetadataRoute } from 'next';

import { source } from '@/lib/source';

/**
 * `/sitemap.xml` — one entry per routed page, derived from the same `source` every other content
 * consumer reads (see INTERNALS, "`source` is a choke point"). Adding a page to `content/docs/`
 * puts it in the sitemap; nothing here needs updating.
 *
 * **Upstream's `nonCanonicalRoutePatterns` has no equivalent here.** Docusaurus routed everything
 * under `docs/`, including partials and auto-generated category pages, so its sitemap needed an
 * ignore list. In this repo partials live in `content/partials/`, archived versions in
 * `content/_versions/`, and the glossary in `content/glossary/` — all outside the doc collection
 * `dir`, so `source.getPages()` cannot return them. There is nothing to exclude.
 *
 * (`draft: true` pages are the one theoretical exception. Nothing in this app filters on `draft`
 * yet — a draft page renders and appears in `llms.txt` — so filtering only here would make the
 * sitemap disagree with what the site actually serves. There are currently no draft pages.)
 *
 * Absolute URLs are required by the sitemap protocol. `NEXT_PUBLIC_SITE_URL` is the deployed
 * origin; the localhost fallback matches `metadataBase` in `app/layout.tsx`, so a local sitemap is
 * still well-formed and self-consistent.
 */
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

// Static data with no request-time input, so this can be generated once at build time rather than
// re-walking every page per request.
export const revalidate = false;

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages().map((page) => {
    // `lastModified` only exists once `lastModified: true` is set on the docs collection in
    // `source.config.ts` (M-35 / FS-2668). Until then it is absent on every page, and the sitemap
    // simply omits `<lastmod>` — which is valid. Read defensively so enabling it later needs no
    // change here, and so this file does not depend on a flag it does not own.
    const lastModified = (page.data as { lastModified?: Date | string }).lastModified;

    return {
      url: new URL(page.url, siteUrl).toString(),
      ...(lastModified ? { lastModified } : {}),
    };
  });

  // The marketing home page at `/` is not part of the doc collection, so it has to be added by
  // hand. It is the site root and the entry point every crawler starts from.
  return [{ url: new URL('/', siteUrl).toString() }, ...pages];
}
