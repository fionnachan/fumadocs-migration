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

export function NotFoundTracker() {
  useEffect(() => {
    // The SDK initialises from an effect too, and effect order across sibling
    // trees is not guaranteed, so retry once on the next macrotask rather than
    // dropping the event when this one wins the race.
    let timer: ReturnType<typeof setTimeout> | undefined;

    const capture = (): boolean => {
      const posthog = (window as unknown as { posthog?: PostHogClient }).posthog;
      if (!posthog) return false;

      posthog.capture('404_error', {
        timestamp: new Date().toISOString(),
        $current_url: window.location.href,
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
        referrer: document.referrer,
        userAgent: window.navigator.userAgent,
      });
      return true;
    };

    if (!capture()) timer = setTimeout(capture, 1000);

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  return null;
}
