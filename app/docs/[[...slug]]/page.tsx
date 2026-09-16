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
  VERSION_PARAM,
  archiveRepoPath,
  canonicalSlug,
  getArchive,
  getVersions,
} from '@/lib/versions';

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

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  // Partial versioning: only pages in the registry expose a version dropdown; unregistered
  // pages render Latest exactly as before.
  const slugKey = canonicalSlug(slug);
  const versions = getVersions(slugKey);
  const requested = (await searchParams)[VERSION_PARAM];
  const requestedId = Array.isArray(requested) ? requested[0] : requested;
  // Unknown/absent `?v=` falls back to Latest (no 404).
  const archive = versions ? getArchive(slugKey, requestedId) : undefined;
  const currentVersionId = archive ? requestedId! : LATEST_ID;

  const MDX = archive ? archive.body : page.data.body;
  const title = archive ? archive.title : page.data.title;
  const description = archive ? archive.description : page.data.description;
  const toc = archive ? archive.toc : page.data.toc;
  // An archived version carries the archive file's own date. `undefined` (a checkout without full
  // git history, see `hasFullGitHistory` in source.config.ts) renders no line at all rather than
  // a wrong one.
  const lastModified = archive ? archive.lastModified : page.data.lastModified;
  const markdownUrl = getPageMarkdownUrl(page).url;
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
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${repoPath}`}
        />
        <RequestUpdateLink pageUrl={page.url} />
        {versions ? <VersionSwitcher options={versions} current={currentVersionId} /> : null}
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

// This route is dynamic because the page `await`s `searchParams` to read `?v=`, so
// `generateStaticParams` has nothing to prerender whatever it returns and returns [] rather than
// 347 params for zero output. `force-dynamic` is load-bearing, not decoration: without it Next
// prerenders a fallback shell for the route, the searchParams access poisons it, and every docs
// page serves that shell as a 500 with digest DYNAMIC_SERVER_USAGE.
//
// Both exports come out together when FS-2698 moves `?v=` off searchParams; either one left alone
// still suppresses all 347 pages. `force-dynamic` also stops applying if Cache Components is ever
// enabled. Measurements and the full reasoning are in INTERNALS.md, "Known trade-off: no static
// prerendering".
export const dynamic = 'force-dynamic';

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const image = getPageImage(page).url;

  return {
    title: page.data.title,
    description: page.data.description,
    // Built absolute from `getSiteUrl()` rather than left relative for `metadataBase` to resolve,
    // so the value a wrong canonical would depend on is read through the one helper that refuses
    // to guess it in production. `page.url` carries no query string, which is what we want: `?v=`
    // selects an archived version of the same document, not a separate canonical page.
    alternates: {
      canonical: new URL(page.url, getSiteUrl()).toString(),
    },
    openGraph: {
      images: image,
    },
    // Next fills twitter:title/description/image from openGraph when they are absent, but the card
    // type and the site handle have no such default and are what X needs to render a large card.
    twitter: {
      card: 'summary_large_image',
      site: socialHandle,
      title: page.data.title,
      description: page.data.description,
      images: [image],
    },
  };
}
