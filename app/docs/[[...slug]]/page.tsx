import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/notebook/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { RequestUpdateLink } from '@/components/RequestUpdateLink';
import { VersionSwitcher } from '@/components/VersionSwitcher';
import { Feedback } from '@/components/feedback/client';
import { getMDXComponents } from '@/components/mdx';
import { onPageFeedbackAction } from '@/lib/posthog';
import { getSiteUrl, gitConfig, socialHandle } from '@/lib/shared';
import { getPageImage, getPageMarkdownUrl, source } from '@/lib/source';
import {
  LATEST_ID,
  archiveParams,
  archiveRepoPath,
  canonicalSlug,
  getVersions,
  resolveArchiveSlug,
} from '@/lib/versions';
import type { VersionedEntry } from '@/lib/versions';

/**
 * "September 11, 2026", matching upstream Docusaurus' `showLastUpdateTime` rendering.
 *
 * Fixed to `en-US` and UTC, not the server's locale or zone: the page is rendered once and cached,
 * so the output must not depend on where it was rendered. Git hands us a commit timestamp with its
 * author's offset, so a late-evening commit can read as the next day in UTC. That is an acceptable
 * one-day skew for a "last updated" line, and the machine-readable `dateTime` carries the exact
 * instant either way.
 */
const lastModifiedFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

function formatLastModified(date: Date): string {
  return lastModifiedFormat.format(date);
}

interface ResolvedRequest {
  /** Always the live page: the archive borrows its URL, its OG image and its relative-link base. */
  page: (typeof source)['$inferPage'];
  /** The archived version to render in the live page's place, or `undefined` for Latest. */
  archive: VersionedEntry | undefined;
  /** Version dropdown options, or `undefined` when the page is not versioned. */
  versions: ReturnType<typeof getVersions>;
  currentVersionId: string;
}

/**
 * Resolve a `/docs/**` path to the page to render, and to the archived version when the last
 * segment names one (`/docs/run-a-node/start-here/v1`).
 *
 * **A real page always wins.** `/docs/a/b` is only reinterpreted as archive `b` of page `a` when no
 * page exists at `a/b`, so an archive id can never shadow a child page; the collision is separately
 * asserted away in `scripts/versions-routing.test.mjs`.
 *
 * Returns `undefined` for a path that is neither, which only `notFound()` can answer. With
 * `dynamicParams = false` that is unreachable from a request (an unknown slug still matches this
 * segment pattern, but its params are rejected and Next answers 404 before rendering starts), so in
 * practice it fires only at build time, for a `VERSIONED` key naming a page that no longer exists.
 */
function resolveRequest(slug: string[] | undefined): ResolvedRequest | undefined {
  const page = source.getPage(slug);
  if (page) {
    return {
      page,
      archive: undefined,
      versions: getVersions(canonicalSlug(slug)),
      currentVersionId: LATEST_ID,
    };
  }

  const resolved = resolveArchiveSlug(slug);
  if (!resolved) return undefined;

  const livePage = source.getPage(resolved.pageSlug);
  if (!livePage) return undefined;

  return {
    page: livePage,
    archive: resolved.entry,
    versions: getVersions(canonicalSlug(resolved.pageSlug)),
    currentVersionId: resolved.id,
  };
}

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const resolved = resolveRequest(slug);
  if (!resolved) notFound();

  const { page, archive, versions, currentVersionId } = resolved;

  const MDX = archive ? archive.body : page.data.body;
  const title = archive ? archive.title : page.data.title;
  const description = archive ? archive.description : page.data.description;
  const toc = archive ? archive.toc : page.data.toc;
  // An archived version carries the archive file's own date. `undefined` (a checkout without full
  // git history, see `hasFullGitHistory` in source.config.ts) renders no line at all rather than
  // a wrong one.
  const lastModified = archive ? archive.lastModified : page.data.lastModified;
  // Archives have no markdown mirror; never offer the live page's text as the archived body.
  const markdownUrl = archive ? undefined : getPageMarkdownUrl(page).url;
  // For an archived version, point the "edit" link at the archive file (whose repo-relative path
  // depends on the storage strategy, so it comes from lib/versions.ts) rather than the live page.
  const repoPath = archive ? archiveRepoPath(archive) : `content/docs/${page.path}`;

  return (
    // Tighter content gutters. Fumadocs' notebook Container puts
    // `px-4 md:px-6 xl:px-8` on the #nd-page article, which spends 32px per side
    // on desktop — the sidebar and the TOC already read as separate columns
    // without it. `cn` (cnfast) drops the conflicting classes, so this replaces
    // the md/xl padding rather than layering on top of it.
    <DocsPage toc={toc} full={page.data.full} className="md:px-4 xl:px-4">
      <DocsTitle className="font-medium">{title}</DocsTitle>
      <DocsDescription className="mb-0">{description}</DocsDescription>
      {lastModified ? (
        <p className="text-fd-muted-foreground text-sm">
          Last updated on{' '}
          <time dateTime={lastModified.toISOString()}>{formatLastModified(lastModified)}</time>
        </p>
      ) : null}
      <div className="flex flex-row flex-wrap gap-2 items-center border-b pb-6">
        {markdownUrl ? <MarkdownCopyButton markdownUrl={markdownUrl} /> : null}
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${repoPath}`}
        />
        <RequestUpdateLink pageUrl={page.url} />
        {versions ? (
          // `basePath` is the live page's URL, so the switcher can build both directions
          // (`basePath` for Latest, `basePath/<id>` for an archive) without importing the registry
          // into a client component or having to strip a version segment off `usePathname()`.
          <VersionSwitcher options={versions} current={currentVersionId} basePath={page.url} />
        ) : null}
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
      <Feedback onSendAction={onPageFeedbackAction} />
    </DocsPage>
  );
}

// The docs route is statically routable: every live page and every archived version is enumerated
// below, and `dynamicParams = false` makes Next answer 404 for any slug outside that list without
// rendering the page.
//
// Both exports are load-bearing, and for two different tickets:
//
//   - `generateStaticParams` returning real params prerenders all live docs pages plus their
//     archives (FS-2698). This became possible only when `?v=` moved off `searchParams` and onto a
//     path suffix in the same change: a page that awaits `searchParams` is dynamic by definition,
//     and a dynamic route prerenders nothing whatever it returns here.
//   - `dynamicParams = false` is what gives `/docs/<missing>` a server-rendered 404 body (FS-2688).
//     An unknown slug still matches this segment pattern, but its params are rejected, so the
//     request lands on the internal `/_not-found` entry and `app/not-found.tsx` renders as an
//     ordinary page with the status set before rendering starts. Left dynamic, the `notFound()`
//     above throws mid-flight-render and Next replaces the whole response with its hardcoded empty
//     `__next_error__` shell.
//
// The accepted cost is that a page added without a rebuild 404s rather than being merely stale, and
// that a failed build takes *new* pages offline. Existing pages keep serving the last good build.
// Full reasoning and measurements in INTERNALS.md, "Static routing under /docs".
export const dynamicParams = false;

export function generateStaticParams(): { slug?: string[] }[] {
  // `.map(({ slug }) => ({ slug }))` drops the `lang` key fumadocs' return type declares but never
  // populates without i18n, so the result matches this route's params exactly.
  return [...source.generateParams().map(({ slug }) => ({ slug })), ...archiveParams()];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const resolved = resolveRequest(slug);
  if (!resolved) notFound();

  const { page, archive } = resolved;
  const title = archive ? archive.title : page.data.title;
  const description = archive ? archive.description : page.data.description;
  const image = getPageImage(page).url;

  return {
    title,
    description,
    // Built absolute from `getSiteUrl()` rather than left relative for `metadataBase` to resolve,
    // so the value a wrong canonical would depend on is read through the one helper that refuses
    // to guess it in production. An archive canonicalizes to its live page: the two are versions of
    // one document, not two documents, and the live one is the copy a reader should land on.
    alternates: {
      canonical: new URL(page.url, getSiteUrl()).toString(),
    },
    // Archives are reachable from the version switcher and from nothing else. These are
    // node-operator guides, so an outdated archive outranking its live page does not merely
    // confuse: it gets stale operational instructions followed in production. `follow` stays on so
    // the links out of an archive still count.
    ...(archive ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      images: image,
    },
    // Next fills twitter:title/description/image from openGraph when they are absent, but the card
    // type and the site handle have no such default and are what X needs to render a large card.
    twitter: {
      card: 'summary_large_image',
      site: socialHandle,
      title,
      description,
      images: [image],
    },
  };
}
