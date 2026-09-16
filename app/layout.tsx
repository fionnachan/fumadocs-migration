import { Banner } from 'fumadocs-ui/components/banner';
import { RootProvider } from 'fumadocs-ui/provider/next';
import 'katex/dist/katex.css';
import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { PostHogProvider } from '@/components/analytics/posthog-provider';
import { Footer } from '@/components/footer';
import { InkeepChatButton } from '@/components/inkeep/inkeep-chat-button';
import InkeepSearchDialog from '@/components/inkeep/inkeep-search';
import { vars } from '@/content/vars';
import { getSiteUrl } from '@/lib/shared';

import './global.css';

export const metadata: Metadata = {
  // Resolved through `getSiteUrl()` rather than read inline, so a production build with no
  // NEXT_PUBLIC_SITE_URL fails here instead of silently baking localhost into every canonical and
  // social image URL. This call is at module scope on purpose: that is what makes it a build
  // failure rather than a per-request one. See lib/shared.ts.
  metadataBase: new URL(getSiteUrl()),
  // Icons live in public/ (not app/, which would recreate the app/favicon.ico
  // route that broke the Vercel build). Declared explicitly so Next emits the
  // <link> tags.
  //
  // The rasters are fallbacks for clients without SVG-favicon support (Safari
  // most notably) and are rendered from the same vector, so they show the same
  // mark rather than a different one. Concrete `sizes` on the .ico matter: with
  // `sizes: 'any'` browsers treat it as scalable and prefer it over the SVG.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/img/logo.svg', type: 'image/svg+xml' },
      { url: '/icon.png', type: 'image/png', sizes: '512x512' },
    ],
    // Not a favicon: iOS composites transparent home-screen icons onto black,
    // so this one keeps its opaque #213147 tile.
    apple: '/apple-icon.png',
  },
};

// Aeonik is the Arbitrum brand typeface, self-hosted from arbitrum-docs.
// Only 400 and 500 exist — there is no Bold or Black face. Heading weights are
// clamped to 500 in global.css so nothing requests a weight the browser would
// have to synthesize, and `font-synthesis: none` there makes any stray 600/700
// resolve to the real 500 face. Fallback stack copied from arbitrum-docs
// _variables.scss. The italic face comes from arbitrum-website (app/font/
// Aeonik-Italic.woff2, same family): without it every <em> was a synthesised
// slant, and with synthesis off it would render upright.
const sans = localFont({
  variable: '--font-sans',
  display: 'swap',
  fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
  src: [
    { path: '../public/fonts/aeonik-regular.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/aeonik-medium.woff2', weight: '500', style: 'normal' },
    { path: '../public/fonts/aeonik-italic.woff2', weight: '400', style: 'italic' },
  ],
});

const mono = localFont({
  variable: '--font-mono',
  display: 'swap',
  fallback: [
    'ui-monospace',
    'SF Mono',
    'Cascadia Code',
    'Segoe UI Mono',
    'Menlo',
    'Monaco',
    'Consolas',
    'monospace',
  ],
  src: [{ path: '../public/fonts/aeonik-fono-regular.woff2', weight: '400', style: 'normal' }],
});

// Aeonik Fono is the brand "mono" but is NOT actually fixed-pitch
// (post.isFixedPitch = 0; advances range 283-799 at 1000 upem). It stays on
// --font-mono for inline code, where brand texture matters and drift is
// invisible. Fenced blocks use a true monospace via --font-code so CLI output,
// ASCII diagrams and aligned comments stay in column.
const code = JetBrains_Mono({
  variable: '--font-code',
  subsets: ['latin'],
  display: 'swap',
});

// FK Screamer is the marketing site's display face (arbitrum-website app/fonts.ts), used there for
// the hero headline and card titles. Here it is the home hero heading only, through the
// `font-display` utility (`--font-display` in global.css). One upright weight exists, so nothing
// else should ask for bold or italic. Shipped at the maintainer's direction on 2026-09-15; the
// licence was granted for arbitrum.io and should be confirmed for this domain with the brand team.
const displayFace = localFont({
  variable: '--font-fk-screamer',
  display: 'swap',
  fallback: ['Impact', 'Haettenschweiler', 'Arial Narrow Bold', 'sans-serif'],
  src: [{ path: '../public/fonts/fk-screamer-upright.otf', weight: '400', style: 'normal' }],
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      // Restores Next's pre-16 behaviour of forcing an instant jump on route transitions while
      // global.css keeps `scroll-behavior: smooth` for in-page anchors. Without it every docs
      // navigation from a scrolled position animates back to the top of the new page.
      data-scroll-behavior="smooth"
      className={`${sans.variable} ${mono.variable} ${code.variable} ${displayFace.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen font-sans" suppressHydrationWarning>
        <RootProvider
          theme={{ attribute: 'class', defaultTheme: 'light' }}
          search={{ SearchDialog: InkeepSearchDialog }}
        >
          {/* Announcement bar, ported from the Docusaurus `announcementBar`.
              Above the navbar because it is a sibling rendered before
              {children}, and every layout's header lives inside those.

              Writers control it from content/vars.json: text, link, and the
              enabled flag, so changing or retiring the message is a content
              edit rather than a code change. `announcementId` is both the
              dismissal key and the cache-buster. A viewer who closes the
              banner has that id written to localStorage, so a new message
              needs a new id or it stays hidden from everyone who dismissed
              the last one. */}
          {vars.announcementEnabled ? (
            <>
              {/* Banner puts `height` in an inline style AND in
                  --fd-banner-height, which the docs layout feeds to calc() and
                  a sticky `top`. So it has to be a real length, never `auto`.
                  The message fits one line from 640px up and wraps to two
                  below, hence the variable rather than a constant.

                  These two values are sized for a message a writer can change
                  without touching this file: 3rem holds two lines of text-sm
                  and 4rem holds three, so a long enough announcementText
                  overflows and nothing catches it. The budget is written down
                  in README next to the key. Raising a height here means
                  raising the budget there too. */}
              <style>{`:root{--fd-announcement-height:4rem}@media (min-width:640px){:root{--fd-announcement-height:3rem}}`}</style>
              <Banner
                id={vars.announcementId}
                height="var(--fd-announcement-height)"
                className="bg-fd-primary text-fd-primary-foreground"
              >
                <span className="pe-8 text-balance">
                  {vars.announcementText}{' '}
                  <Link
                    href={vars.announcementLinkHref}
                    // vars:check permits an https target as well as an internal
                    // path, so the href may leave the site. `rel` is set only
                    // then, because Next already omits it for internal routes
                    // and an unconditional one would be noise on every page.
                    rel={
                      vars.announcementLinkHref.startsWith('https://')
                        ? 'noopener noreferrer'
                        : undefined
                    }
                    className="underline underline-offset-2 hover:no-underline"
                  >
                    {vars.announcementLinkText}
                  </Link>
                </span>
              </Banner>
            </>
          ) : null}
          {children}
          {/* Fumadocs exposes no footer slot, so the site footer is a sibling of
              the layout inside the flex column body. See components/footer.tsx. */}
          <Footer />
          <InkeepChatButton />
          {/* Renders nothing. Production-only web analytics; see
              components/analytics/posthog-provider.tsx. */}
          <PostHogProvider />
        </RootProvider>
      </body>
    </html>
  );
}
