'use client';

import { useEffect } from 'react';

// Reports a 404 to PostHog, porting the capture in upstream
// src/theme/NotFound/Content/index.tsx. Feeds the inbound-404 monitoring that
// drives the legacy redirect map after cutover.
//
// Deliberately talks to `window.posthog` rather than importing posthog-js:
// the SDK is loaded only on production (see posthog-provider.tsx), and a
// static import here would pull it into the bundle on every deployment. With
// no client, this captures nothing and renders nothing.

type PostHogClient = {
  capture: (event: string, properties?: Record<string, unknown>) => void;
};

/**
 * Delay before each attempt, in milliseconds, measured from the attempt before it.
 *
 * The SDK arrives in a ~290 kB async chunk that another effect starts loading, so on a slow
 * connection it resolves well after this component mounts and no ordering between the two is
 * guaranteed. Retrying once a second later loses exactly the events worth having: the ones from
 * readers on bad networks. This spans about 16 seconds and then stops, rather than leaving a timer
 * alive for the life of the page.
 */
const RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000, 4000, 8000];

export function NotFoundTracker() {
  useEffect(() => {
    // Snapshot the location now, not at capture time. A late attempt must still report the URL the
    // reader actually landed on.
    const properties = {
      timestamp: new Date().toISOString(),
      $current_url: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      referrer: document.referrer,
      userAgent: window.navigator.userAgent,
    };

    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tryCapture = () => {
      const posthog = (window as unknown as { posthog?: PostHogClient }).posthog;
      if (posthog) {
        posthog.capture('404_error', properties);
        return;
      }

      attempt += 1;
      if (attempt >= RETRY_DELAYS_MS.length) return;
      timer = setTimeout(tryCapture, RETRY_DELAYS_MS[attempt]);
    };

    timer = setTimeout(tryCapture, RETRY_DELAYS_MS[0]);

    return () => clearTimeout(timer);
  }, []);

  return null;
}
