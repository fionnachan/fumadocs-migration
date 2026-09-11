import { waitUntil } from '@vercel/functions';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { NextRequest, NextResponse } from 'next/server';

import {
  DOCS_CONTENT_ROUTE,
  DOCS_ROUTE,
  buildTrackingPayload,
  pathInfo,
} from '@/lib/llms-tracking';
import { docsContentRoute, docsRoute } from '@/lib/shared';
import { redirects } from '@/redirects.config.mjs';

// `lib/llms-tracking.ts` keeps its own copies of these two constants so it stays import-free and
// therefore directly testable under plain `node --test` (see the comment at the top of that file).
// These two statements are the compile-time proof that the copies still match: both constants have
// literal types, so moving one without the other fails `pnpm types:check`.
DOCS_ROUTE satisfies typeof docsRoute;
DOCS_CONTENT_ROUTE satisfies typeof docsContentRoute;

/**
 * Legacy source -> destination, for `.md`-suffixed requests only.
 *
 * `next.config` redirects run before this proxy, and their sources are bare paths, so `/anytrust`
 * redirects but `/anytrust.md` matches nothing and falls through here as a 404. The suffix rewrite
 * below cannot help: it only matches paths already under `/docs`. Looking the bare path up in the
 * same table the redirect layer uses closes that hole and keeps the markdown intent — the reader
 * is sent to the destination's `.md`, not its HTML.
 *
 * Only internal destinations are eligible; an external one has no `.md` form.
 */
const legacyDestinations = new Map(
  redirects.filter((r) => r.destination.startsWith('/')).map((r) => [r.source, r.destination]),
);

const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteSuffix } = rewritePath(
  `${docsRoute}{/*path}.md`,
  `${docsContentRoute}{/*path}/content.md`,
);

const POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Records one markdown or `llms*.txt` fetch in PostHog, continuing the `llms_file_fetched` series
 * upstream's `middleware.ts` produces. Ported from that middleware.
 *
 * **Production only.** `VERCEL_ENV` is unset locally and is `'preview'` on preview deployments, so
 * neither sends anything. That keeps development traffic and per-PR crawling out of the numbers,
 * and means no key is needed to run this app.
 *
 * Never blocks and never throws: the capture is handed to `waitUntil` so the response goes out
 * immediately, and every failure path is swallowed after logging. A docs page must not fail
 * because an analytics write did.
 */
function trackRequest(request: NextRequest, path: string): void {
  if (process.env.VERCEL_ENV !== 'production') return;

  const info = pathInfo(path, request.headers.get('accept') ?? '');
  if (info.kind === 'ignored') return;

  // Read on the server despite the NEXT_PUBLIC_ prefix — that is PostHog's documented name for the
  // publishable `phc_` project token, which is write-only. Same variable `lib/posthog.ts` uses.
  const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!posthogKey) {
    console.error(
      '[llms-tracking] dropping event: NEXT_PUBLIC_POSTHOG_KEY is unset in production. Set it to ' +
        'the PostHog project token (Project settings -> Project API key) on Vercel.',
    );
    return;
  }

  try {
    waitUntil(
      buildTrackingPayload({
        trackedPath: info.trackedPath,
        fileType: info.fileType,
        userAgent: request.headers.get('user-agent') ?? '',
        referrer: request.headers.get('referer') ?? '',
        // Only the first entry is the client; the rest are proxies. The value is never stored —
        // `buildTrackingPayload` hashes it with a daily salt into the distinct_id.
        ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '',
        posthogKey,
        siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin,
      })
        .then((payload) =>
          fetch(`${POSTHOG_HOST}/i/v0/e/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        )
        .catch((error) => {
          console.error('[llms-tracking] could not reach PostHog:', error);
        }),
    );
  } catch (error) {
    // `waitUntil` itself can throw outside a request context. Nothing about tracking is worth a 500.
    console.error('[llms-tracking] could not schedule the capture:', error);
  }
}

export default function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Before the bypass list: `/llms.txt`, `/llms-full.txt` and the `/llms.mdx/` mirrors are all
  // served verbatim below, and they are exactly the fetches worth counting. A rewrite does not
  // re-enter the proxy, so a `/docs/x.md` request is counted here once, not again as the
  // `/llms.mdx/docs/x/content.md` it rewrites to.
  trackRequest(request, path);

  // Routes served verbatim — skip markdown content-negotiation entirely.
  if (
    path.startsWith('/_next/') ||
    path.startsWith('/img/') ||
    path === '/favicon.ico' ||
    path === '/icon.png' ||
    path === '/apple-icon.png' ||
    path === '/nitro-whitepaper.pdf' ||
    path.startsWith('/audit-reports/') ||
    // Metadata routes (app/sitemap.ts, app/robots.ts). Listed by the same convention as every
    // other top-level route rather than because a rewrite currently reaches them: both rewrite
    // patterns below are anchored at `/docs`, so neither matches these paths today. That anchoring
    // is an implementation detail of the patterns, not a promise — a route that must be served
    // verbatim belongs here, where it is one line and cannot be broken from a distance.
    path === '/sitemap.xml' ||
    path === '/robots.txt' ||
    path === '/llms.txt' ||
    path === '/llms-full.txt' ||
    path.startsWith('/llms.mdx/') ||
    path.startsWith('/og/') ||
    path.startsWith('/api/')
  ) {
    return NextResponse.next();
  }

  // 0. `.md` on a legacy URL: redirect to the destination's `.md`. Must precede the suffix
  //    rewrite, which only recognises paths already under `/docs`.
  if (path.endsWith('.md') && !path.startsWith(`${docsRoute}/`)) {
    const destination = legacyDestinations.get(path.slice(0, -'.md'.length));
    if (destination) {
      return NextResponse.redirect(new URL(`${destination}.md`, request.nextUrl), 307);
    }
  }

  // 1. Explicit `.md` suffix: rewrite to the markdown route.
  const suffixResult = rewriteSuffix(request.nextUrl.pathname);
  if (suffixResult) {
    return NextResponse.rewrite(new URL(suffixResult, request.nextUrl));
  }

  // 2. Content negotiation: `Accept: text/markdown` rewrites to the .md route.
  if (isMarkdownPreferred(request)) {
    const negResult = rewriteDocs(request.nextUrl.pathname);
    if (negResult) {
      return NextResponse.rewrite(new URL(negResult, request.nextUrl));
    }
  }

  return NextResponse.next();
}
