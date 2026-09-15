import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { NextFetchEvent, NextRequest, NextResponse } from 'next/server';

import {
  DOCS_CONTENT_ROUTE,
  DOCS_ROUTE,
  buildTrackingPayload,
  pathInfo,
} from '@/lib/llms-tracking';
import { docsContentRoute, docsRoute, getSiteUrl } from '@/lib/shared';
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
 * Never blocks and never throws: the capture is handed to `event.waitUntil()` so the response goes
 * out immediately, and every failure path is swallowed after logging. A docs page must not fail
 * because an analytics write did.
 *
 * **The `event.waitUntil` here must not be replaced with `waitUntil` from `@vercel/functions`.**
 * That helper resolves the request context through
 * `globalThis[Symbol.for('@vercel/request-context')]`, and when the symbol is absent `getContext()`
 * returns `{}` and `.waitUntil?.()` is a no-op that drops the promise without a word. Next 16 does
 * not install that symbol; it installs `@next/request-context`. The `NextFetchEvent` Next hands the
 * proxy as its second argument is the framework's own documented mechanism and is always present,
 * which is also what upstream's middleware used.
 *
 * This distinction is invisible locally: the promise chain starts executing the moment it is
 * constructed, so in `next dev` the fetch completes either way. `waitUntil` only extends the
 * runtime's lifetime past the response, which matters solely on a serverless host that would
 * otherwise freeze the invocation with the request in flight.
 */
function trackRequest(request: NextRequest, event: NextFetchEvent, path: string): void {
  if (process.env.VERCEL_ENV !== 'production') return;

  const info = pathInfo(path, request.headers.get('accept') ?? '');
  if (info.kind === 'ignored') return;

  // Read on the server despite the NEXT_PUBLIC_ prefix. That is PostHog's documented name for the
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
    event.waitUntil(
      buildTrackingPayload({
        trackedPath: info.trackedPath,
        fileType: info.fileType,
        userAgent: request.headers.get('user-agent') ?? '',
        referrer: request.headers.get('referer') ?? '',
        // Only the first entry is the client; the rest are proxies. The raw value never leaves this
        // function: `buildTrackingPayload` turns it into the salted hash that becomes the
        // distinct_id. An empty string here means the header was absent, and the payload builder
        // gives those requests a random id rather than one shared bucket.
        ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '',
        posthogKey,
        // The configured origin, not `request.nextUrl.origin`. A production deployment answers on
        // its `*.vercel.app` alias as well as on the custom domain, so the request origin would
        // record two different `$current_url` values for one page and split the series. This is
        // also the one helper that owns the site-URL rule (`lib/site-url.mjs`), so reading the
        // variable here by hand would put a second consumer outside it. It throws when the
        // variable is unset in production, which `next.config.mjs` already refuses to build
        // without; the `try` below contains that throw either way.
        siteUrl: getSiteUrl(),
      })
        .then((payload) =>
          fetch(`${POSTHOG_HOST}/i/v0/e/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        )
        .then(async (response) => {
          // `fetch` rejects only on a network failure, so a rejected event resolves here rather
          // than in the `catch` below. Without this, a revoked or mistyped project token would
          // return 401 and read exactly like no traffic at all, and this feature only runs in
          // production, where nobody is watching a console for it.
          if (!response.ok) {
            console.error(
              `[llms-tracking] PostHog rejected the event (${response.status}): ` +
                `${await response.text()}`,
            );
          }
        })
        .catch((error) => {
          console.error('[llms-tracking] could not reach PostHog:', error);
        }),
    );
  } catch (error) {
    // Defensive: scheduling should not throw here, but nothing about tracking is worth a 500.
    console.error('[llms-tracking] could not schedule the capture:', error);
  }
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const path = request.nextUrl.pathname;

  // Before the bypass list: `/llms.txt`, `/llms-full.txt` and the `/llms.mdx/` mirrors are all
  // served verbatim below, and they are exactly the fetches worth counting. A rewrite does not
  // re-enter the proxy, so a `/docs/x.md` request is counted here once, not again as the
  // `/llms.mdx/docs/x/content.md` it rewrites to.
  trackRequest(request, event, path);

  // Routes served verbatim: skip markdown content-negotiation entirely.
  if (
    path.startsWith('/_next/') ||
    path.startsWith('/img/') ||
    path === '/favicon.ico' ||
    path === '/icon.png' ||
    path === '/apple-icon.png' ||
    path === '/nitro-whitepaper.pdf' ||
    path.startsWith('/audit-reports/') ||
    // Static JSON that a widget fetches at runtime (public/data/). Same convention as the
    // metadata routes below: no rewrite reaches it today, and it is listed anyway.
    path.startsWith('/data/') ||
    // Metadata routes (app/sitemap.ts, app/robots.ts). Listed by the same convention as every
    // other top-level route rather than because a rewrite currently reaches them: both rewrite
    // patterns below are anchored at `/docs`, so neither matches these paths today. That anchoring
    // is an implementation detail of the patterns, not a promise. A route that must be served
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
