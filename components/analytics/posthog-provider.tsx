'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type { PostHog } from 'posthog-js';
import { Suspense, useEffect } from 'react';

// Client-side PostHog, ported from the Docusaurus `posthog-docusaurus` plugin
// and src/components/PostHogProvider.tsx. Two jobs: capture a `$pageview` on
// every App Router navigation, and put the client on `window.posthog` so the
// Inkeep event bridge in lib/inkeep.ts (written before this existed, and
// unchanged by this file) starts emitting its `inkeep_*` events.
//
// Server-side feedback capture lives in lib/posthog.ts and is independent of
// this module: it posts to the capture API directly and works everywhere,
// including local and preview.

const POSTHOG_HOST = 'https://us.i.posthog.com';

// Both reads below must stay literal `process.env.NEXT_PUBLIC_*` member
// expressions. Next inlines those into the client bundle at build time, so on
// any non-production build this constant folds to `false` and the `if` in
// loadPostHog() is dead code. Destructure `process.env` into a local first and
// the value becomes a runtime lookup instead, which defeats that.
//
// The SDK is behind `import()` so it lands in its own async chunk (~290 kB)
// rather than the chunk the layout loads. Turbopack still emits that chunk on
// a non-production build, but nothing ever requests it: no script fetch, no
// init, no events. Verified on a production build with the gate off.
//
// VERCEL_ENV itself is server-only. Vercel exposes the same value to the
// browser as NEXT_PUBLIC_VERCEL_ENV, which is what a client component has to
// read. It is 'production' only on the production deployment, 'preview' on
// every preview build, and unset locally, so neither preview nor local loads
// the SDK. This mirrors the `VERCEL_ENV === 'production'` gate upstream put on
// the posthog-docusaurus plugin.
const projectKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const analyticsEnabled = process.env.NEXT_PUBLIC_VERCEL_ENV === 'production' && Boolean(projectKey);

/** Resolves once per page load; `null` whenever analytics is off or the SDK failed to load. */
let clientPromise: Promise<PostHog | null> | null = null;

function loadPostHog(): Promise<PostHog | null> {
  if (!analyticsEnabled) return Promise.resolve(null);

  clientPromise ??= import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(projectKey as string, {
        api_host: POSTHOG_HOST,
        // Pinned rather than left 'unset' so a posthog-js upgrade cannot change
        // capture behaviour without a code change here.
        defaults: '2026-08-30',
        // The four options below match the Docusaurus plugin config: no cookies
        // or localStorage, no session replay, and pageviews captured by hand
        // (see PageviewTracker) because the App Router does not do full page
        // loads on navigation.
        persistence: 'memory',
        disable_session_recording: true,
        capture_pageview: false,
        autocapture: false,
        // Upstream's `advanced_disable_decide: true` under its current name.
        // Skips the remote-config request, so no flags, surveys or toolbar.
        advanced_disable_flags: true,
      });

      // The contract lib/inkeep.ts codes against: an object with `capture`.
      (window as Window & { posthog?: PostHog }).posthog = posthog;
      return posthog;
    })
    .catch((error: unknown) => {
      // Analytics must never take a docs page down.
      console.error('[Analytics] could not load posthog-js:', error);
      return null;
    });

  return clientPromise;
}

/**
 * Captures `$pageview` on first paint and on every client-side navigation.
 *
 * `useSearchParams` makes this component dynamic, hence the Suspense boundary
 * its parent wraps it in.
 */
function PageviewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    let cancelled = false;

    void loadPostHog().then((posthog) => {
      if (cancelled || !posthog) return;
      const query = searchParams.toString();
      posthog.capture('$pageview', {
        $current_url: `${window.location.origin}${pathname}${query ? `?${query}` : ''}`,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [pathname, searchParams]);

  return null;
}

/**
 * Mounts web analytics. Renders no DOM; it is a sibling of the page tree inside
 * `RootProvider`, not a wrapper, so nothing below it becomes a client
 * component.
 *
 * Returns `null` outside production, which is what keeps `useSearchParams` out
 * of the tree on local and preview builds.
 */
export function PostHogProvider() {
  if (!analyticsEnabled) return null;

  return (
    <Suspense fallback={null}>
      <PageviewTracker />
    </Suspense>
  );
}
