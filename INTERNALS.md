# INTERNALS

How this codebase works, and why it is built the way it is. For the docs team and anyone
maintaining the tooling.

Task-level instructions — setup, writing a page, using a partial — live in [README](README.md).
Getting a first contribution to an open PR is [CONTRIBUTE](CONTRIBUTE.md). The house prose rules
are [STYLE-GUIDE](STYLE-GUIDE.md), which is editorial, not technical, and nothing in this file
governs it. `CLAUDE.md` is machine-facing and duplicates parts of this file for coding agents;
**this file is canonical for humans, and the one to edit first.**

## Contents

- [What Fumadocs is](#what-fumadocs-is)
- [Coming from Docusaurus](#coming-from-docusaurus)
- [The pipeline](#the-pipeline)
- [`source` is a choke point](#source-is-a-choke-point)
- [The sidebar and its roots](#the-sidebar-and-its-roots)
- [The frontmatter contract](#the-frontmatter-contract)
- [Last modified dates](#last-modified-dates)
- [Page metadata](#page-metadata)
- [Partials](#partials)
- [Global variables](#global-variables)
- [Redirects](#redirects)
- [Routing and `proxy.ts`](#routing-and-proxyts)
- [Partial versioning](#partial-versioning)
- [Glossary and inline references](#glossary-and-inline-references)
- [Custom MDX components](#custom-mdx-components)
- [Remote images are never fetched at build](#remote-images-are-never-fetched-at-build)
- [Page weight and what loads late](#page-weight-and-what-loads-late)
- [The Node runtime](#the-node-runtime)
- [Analytics](#analytics)
- [The gates](#the-gates) (including [Generated pages](#generated-pages) and
  [Stylus by Example](#stylus-by-example))
- [The content-lint rules](#the-content-lint-rules)
- [What nothing catches](#what-nothing-catches)
- [Static routing under `/docs`](#static-routing-under-docs)
- [Design specs](#design-specs)

## What Fumadocs is

Fumadocs is **not** an all-in-one docs framework. It is a set of libraries you assemble on top of a
Next.js App Router app that you own and can edit. Its own docs describe it as "a docs framework that
you can break," in contrast to monolithic tools like Docusaurus. There is no `fumadocs build`, no
plugin system, and no theme to eject from — `pnpm dev` is `next dev`, and every route under `app/`
is ordinary Next code.

That trade is the thing to internalise: **we get full control, and in exchange we own the pieces a
monolith would have supplied.** Most of this document describes those pieces.

Four packages are installed here:

| Package             | Version | Responsible for                                                                 |
| ------------------- | ------- | ------------------------------------------------------------------------------- |
| `fumadocs-core`     | 16.15.9 | Headless engine: the Loader API, page tree, search, TOC, MDX plugins            |
| `fumadocs-mdx`      | 15.4.0  | The content source: compiles MDX into typed **collections**                     |
| `fumadocs-ui`       | 16.15.9 | The default theme: `DocsPage`/`DocsBody` layouts, tabs, accordions, code blocks |
| `fumadocs-twoslash` | 4.0.1   | Type-checked TypeScript code samples (` ```ts twoslash `)                       |

`fumadocs-ui` is a theme, not a requirement — the headless core would work without it. We use it,
and override its tokens rather than forking it.

### The four concepts

**Collections.** A collection is a typed set of content files, declared in `source.config.ts` via
`defineDocs()` or `defineCollections()`. Each declares a `dir`, a file glob, and a Zod `schema` that
every file's frontmatter must satisfy. `fumadocs-mdx` compiles them into the generated `.source/`
directory. This repo declares three: `docs` (routed), `docsVersions` (archived pages), and
`glossary` (reference entries).

**The Loader API.** `loader()` from `fumadocs-core/source` turns a compiled collection into a
`source` object — the query interface the rest of the app uses: `getPage(slug)`, `getPages()`, the
page tree, and URL derivation from the `baseUrl` you pass it. It is the seam that lets a content
source be swapped (local MDX, Notion, Sanity) without touching route code. See
[`source` is a choke point](#source-is-a-choke-point) for the rules we hold ourselves to around it.

**The page tree.** The hierarchical structure behind the sidebar and breadcrumbs, derived from the
directory layout and refined by a `meta.json` in each directory. `meta.json` controls **order and
grouping** — its `pages: []` array takes basename slugs and supports `...` rest-globs,
`---Separator---`, `[text](url)` external links, and `!exclude`. The visible hierarchy is applied by `lib/docs-navigation.json` and its source transformer.
The transformer creates the visible section roots, one per navbar section. See [The sidebar and its roots](#the-sidebar-and-its-roots).

**The catch-all route.** One file, `app/docs/[[...slug]]/page.tsx`, renders every docs page. It
takes the slug segments, calls `source.getPage()`, and renders. Adding an `.mdx` file creates a
route with no wiring; there is no per-page React file.

**The action row** under the title holds `MarkdownCopyButton`, `ViewOptionsPopover`,
`RequestUpdateLink` (`components/RequestUpdateLink.tsx`, the port of the Docusaurus `HeaderBadges`
"Request an update" badge: a server-rendered link to a prefilled GitHub issue, built from
`gitConfig`, which reads the repository URL from
[`content/vars.json`](#this-repositorys-own-url-has-one-owner), plus `page.url` and
`NEXT_PUBLIC_SITE_URL`), and, on versioned pages only,
`VersionSwitcher`. The [last updated](#last-modified-dates) line sits above it, between the
description and the row.

**Slugs are the file path minus the extension**, with a trailing `index` dropped —
`content/docs/stylus/quickstart.mdx` serves at `/docs/stylus/quickstart`, given `baseUrl: '/docs'`.

## Coming from Docusaurus

This repo replaced the Docusaurus site at `OffchainLabs/arbitrum-docs`, which is archived. Nothing
here reads that repo any more, and nothing may start to. Most of the team arrived from it, though,
so the differences that actually cause mistakes are worth keeping written down:

| Docusaurus                                          | Here                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `docusaurus.config.js`, presets, plugins            | `next.config.mjs` + `source.config.ts`; no plugin system            |
| `sidebars.js` — one global file                     | A `meta.json` per directory                                         |
| Swizzling to override a theme component             | Edit the component; it is your code                                 |
| `onBrokenLinks: 'throw'`                            | Nothing built in — hence `check-links`, see [The gates](#the-gates) |
| `02-foo/bar` → `/foo/bar` (numeric prefix stripped) | **Prefix kept verbatim** in the slug                                |
| `@@varName@@` preprocessing                         | `<Var name="…" />`, see [Global variables](#global-variables)       |
| Client-redirects plugin + synced `vercel.json`      | Next `redirects()` only, see [Redirects](#redirects)                |
| `docs:move` style tooling                           | None official — `pnpm move-doc` is ours                             |

The numeric-prefix rule was the sharpest edge when porting URLs: a path that Docusaurus served at
`/foo/bar` serves at `/02-foo/bar` here unless the directory is renamed or a redirect is added. It
is why `redirects.legacy.mjs` exists, and it still decides where a hand-added legacy redirect should
point.

`@fumadocs/cli` exists but only **installs UI components**. It does not move, rename, or restructure
docs, and it does not manage redirects. Every tool in `scripts/` exists because nothing else
provides it.

## The pipeline

Understanding the build requires reading `source.config.ts`, `lib/source.ts`, and
`app/docs/[[...slug]]/page.tsx` together. Nothing else reads content.

1. `fumadocs-mdx` scans `content/docs/**`, validates every page's frontmatter against the Zod
   schema in `source.config.ts`, and emits the `.source/` collection.
2. `lib/source.ts` runs Fumadocs `loader()` over that collection with the icons plugin, exporting
   the `source` object.
3. Route handlers read `source`. `app/docs/[[...slug]]/page.tsx` renders pages; the `llms.txt`,
   `llms-full.txt`, `llms.mdx/`, and `og/` routes all derive from the same object.

Change the content model in one place and every consumer follows.

`.source/` is generated — by `postinstall`, by `types:check`, and by `build`. Never hand-edit it;
regenerate instead.

## `source` is a choke point

Treat `source.config.ts` and `lib/source.ts` as one unit. Seven files under `app/` import `source`
and nothing else reads content. The constraints that follow are deliberate:

- `docs.toFumadocsSource()` is the **only** adapter for `.source/`. Never build a second read path.
- `baseUrl` is an argument to the single `loader()` call. A second loader would restate it and
  silently drift page URLs.
- Helpers are typed `(typeof source)['$inferPage']`, so editing the frontmatter schema re-types
  every helper and every consumer at once.
- `postprocess.includeProcessedMarkdown: true` is what makes `getLLMText()`'s
  `page.data.getText('processed')` work. Remove it and the `llms*` routes break, far from where
  the flag lives.
- Put URL derivation next to `source` — `getPageImage`, `getPageMarkdownUrl`, `getLLMText` — not
  in route handlers.

**`lib/source` is server-only.** Never import it, or a constant that transitively pulls it, from a
client component: it drags the compiled collection into the browser bundle. One such import once
cost a 24 MB chunk on every docs page. No gate catches this — see
[What nothing catches](#what-nothing-catches).

## The sidebar and its roots

The visible sidebar hierarchy is declared in `lib/docs-navigation.json`. It preserves the
section menus, labels, ordering and nested categories from the original Arbitrum documentation.
The `reference` field records the exact `arbitrum-docs` revision used for the migration; this is
provenance only. Builds and runtime do not fetch or import that repository.

`meta.json` files still describe the content folders consumed by Fumadocs. The single loader in
`lib/source.ts` applies `buildDocsNavigation` as a page-tree root transformer, arranging those real
page nodes into the editorial hierarchy. The sidebar, breadcrumbs and previous/next navigation
therefore share the same tree. Page URLs and MDX files do not change when a menu category changes.

**There is no root switcher.** Fumadocs would render a dropdown above the tree (its `tabs` option,
one entry per section root) that names the current section and lists every sibling. That is a
second copy of the navbar's section list, and it let a reader hop between main-menu sections from
inside the sidebar, which is not what a sidebar is for. `app/docs/layout.tsx` passes `tabs={false}`:
the navbar chooses the section and the sidebar shows that section's tree, as the Docusaurus site
behaved. Roots still decide which tree a page gets, because `TreeContextProvider` picks the last
root on the page's path whether or not a switcher renders.

Each manifest section has an `id` naming its source folder and `sourceFolders` assigning local
content to it. Entries use `page` for a canonical page, `href` for a shortcut, `children` for a
nested category, or `folder` to include a local subtree such as third-party docs or Stylus examples.
An optional `name` supplies the shorter sidebar label; otherwise page `sidebar_label` metadata is
honored. A folder entry with `flatten: true` inserts its children directly into the category. Missing pages, references or folders throw
an error instead of silently dropping menu items.

**Cross-section links must use `href`.** Fumadocs finds a page's sidebar by walking the tree to the
first matching page node, then taking its last root folder. Repeating a canonical `page` in another
section can therefore give the destination the wrong sidebar. The transformer represents `href`
entries as display-only separator nodes carrying a URL. `SidebarNavigationReference`, configured
in `app/docs/layout.tsx`, renders these as normal sidebar links; Fumadocs' page lookup and
previous/next traversal ignore them. For example, the Stylus quickstart link under Get started
opens the Stylus sidebar, while Chain info, Glossary, and Audit reports belong to Get started.

Local pages not explicitly listed in the manifest remain available under **Additional guides**
inside their assigned section. This retains migration-era and newly added content without
inserting it into the original learning sequence. Add an explicit entry to place a page in the
main menu. Three PGA/Fast Feed pages absent from the migrated content link to the original site
until local equivalents exist. The synced Stylus examples remain local under Reference.

The footer pins Chain info, Glossary and Contribute below each sidebar, matching the original
section menus. `SidebarResourceLinks` is passed as a component so the notebook layout's hidden
footer wrapper does not hide the links on desktop. Its links live in `lib/shared.ts` and are
checked by `scripts/lib/shared.test.mjs`.

`pnpm nav:check` checks the underlying `meta.json` tree for missing entries, hidden files, uncovered
pages and shadowing links. `scripts/docs-navigation.test.mjs` additionally loads the real local
content through Fumadocs and verifies the final hierarchy, complete page coverage, unique section
ownership, and cross-section destinations. Check rendered desktop and mobile navigation when
changing the layout or reference renderer.

## The frontmatter contract

`source.config.ts` extends the Fumadocs page schema. Every non-partial `.mdx` page **must** carry
`title`, `description`, `content_type`, `author`, and `sme`.

`content_type` is a fixed enum: `how-to`, `concept`, `quickstart`, `tutorial`, `reference`,
`troubleshooting`, `faq`. Optional fields: `sidebar_label`, `user_story`, `draft`.

A missing or invalid field fails `types:check` and `build`. This is the most common reason a build
breaks after adding content.

## Last modified dates

Each docs page prints "Last updated on <date>" under its description, the equivalent of upstream
Docusaurus' `showLastUpdateTime`. The date is not frontmatter and writers never set it: the
`lastModified` option on the `docs` and `docsVersions` collections makes `fumadocs-mdx` read it
from git, and `page.data.lastModified` (a `Date`) reaches the page component through the same
`source` object as everything else. An archived version shows the archive file's own date, not the
live page's.

**No date is resolved unless the checkout has complete git history**, decided by the
`hasFullGitHistory()` probe at the top of `source.config.ts`. This is not belt and braces. In a
shallow clone the oldest commit is grafted in as a parentless root, so git diffs it against the
empty tree and reports it as adding every file under it. Measured on this repo at `--depth=10`:
430 of about 450 pages came back stamped with a single boundary commit that in full history
touched no content at all. A wrong date on every page is worse than no date, so the probe yields
no dates instead. Nothing renders, no error appears, and nothing fails.

**The option is never set to `false`, and that detail is load-bearing.** `lastModified` is part of
the collection's _type_ contract, not only its behaviour: fumadocs-mdx adds the
`lastModified?: Date` field to the generated `DocData` only when the option is truthy. Setting it
to `false` in a shallow checkout deletes the field from the type, and the docs page then fails
`types:check` with TS2339. That makes the gate pass or fail according to how the repository
happened to be cloned, which is exactly what happened on the first attempt at this change: green
locally, red in CI, because `actions/checkout` clones shallow. The probe therefore chooses between
two _truthy_ values. With full history it passes `true`, which uses fumadocs-mdx's batched
`git log`. Without it, it passes a resolver that returns `undefined` for every file, which keeps
the field typed while yielding no dates.

The choice is made in `source.config.ts` at build time rather than at render time because pages
render on demand in a serverless runtime that has neither git nor the repository.

**What a reviewer must configure.** Vercel clones at `--depth=10` by default, so the dates are
absent on previews and in production until someone sets `VERCEL_DEEP_CLONE=true` in the Vercel
project's environment variables. Nothing else is needed: a deep clone makes the probe pass on its
own. The same applies to any CI job that wants the dates, since `actions/checkout` defaults to
`fetch-depth: 1`. No gate depends on the dates, so `ci.yml` is deliberately left alone.

The rendered date is formatted in UTC so that the output does not depend on which machine rendered
the page. A commit made late in the evening in a western timezone therefore reads as the next day.
The machine-readable `dateTime` attribute on the `<time>` element always carries the exact instant.

## Page metadata

`generateMetadata` in `app/docs/[[...slug]]/page.tsx` emits the per-page title and description, an
Open Graph image from the `og/` route, a canonical URL, and the Twitter card tags
(`summary_large_image`, site `@arbitrum`). The canonical deliberately uses `page.url`, the live
page's URL, so an archived view at `/docs/<slug>/<id>` canonicalizes to its live page rather than
splitting one document in two. Archives also carry `robots: noindex, follow`. **`og:site_name`,
`og:url` and `og:type` (FS-2724)**: `og:site_name` is `appName` from `lib/shared.ts`, the same
constant the site root's `openGraph.siteName` uses, so the two cannot drift. `og:url` is the same
absolute string `alternates.canonical` carries, computed once into one `canonical` constant and
spent on both, since they are one claim addressed to two readers; an archive therefore names its
live page in both. Next emits `og:url` only from an explicit `openGraph.url` and synthesizes
nothing from the canonical, so before this ticket a docs page had none while `/` did. `og:type` is
`article`, not the `website` the root uses, and it is applied **uniformly to everything the
catch-all serves**, `/docs` and the section landing pages included. The distinction being drawn is
root versus docs, not index versus document: nothing in either collection marks a page as an index,
so singling out the landing pages would take a hand-kept list of URLs that goes stale the moment a
section is added, and `og:type` drives no crawler behaviour that would pay for it.
`scripts/static-docs-http.test.mjs` asserts `/docs` is `article` so that uniformity is recorded as
a decision rather than read later as an oversight. `article` also unlocks `article:modified_time`,
set from the same `lastModified` (`page.data.lastModified` for Latest, `archive.entry.lastModified`
for an archive) the page body already renders as "Last updated on …", and omitted along with that
line when the checkout has no full git history (`hasFullGitHistory` in source.config.ts). Because
that makes the tag absent in CI, which checks out shallow, the test asserts it is present **if and
only if** the body carries the "Last updated on" `<time dateTime>` and that the two instants match,
rather than skipping the assertion when the tag is missing, which would never execute in the one
place the suite runs automatically. `article:published_time` is deliberately not set, because
nothing in the frontmatter or either collection records when a page was first published, only git's
last-touched date, which is what `modifiedTime` already is. Archives get all three new tags too:
`noindex` controls crawling, not what kind of object the URL is, and an archive's own `lastModified`
is a real per-document date, not the live page's. That leaves an archive's OG object naming the
live page's URL while dating the archive itself, and the two coincide today only because one commit
last touched both files; accepted, because `og:url` is the OG object's canonical, which for an
archive is its live page, while the date describes the document actually served.

**The site root publishes the same set, from a static `metadata` object in `app/(home)/page.tsx`**
(FS-2713). It shipped with none of it: measured on a production build of `3064177`, the only
`<meta name>` tags on `/` were `viewport` and `next-size-adjust`, `grep -c '<title'` returned 0,
and Lighthouse scored the page 83 on SEO with `document-title` and `meta-description` both failing,
against 100 for every docs page. The root is the URL most likely to be shared and indexed.

Its title and description are `siteTitle` and `siteDescription` in `lib/shared.ts`, beside
`appName`, so the page and its social card render from one pair of strings. **They are deliberately
not the docs landing page's own title and description.** `content/docs/index.mdx` is titled
"Arbitrum docs", and `/` and `/docs` are two separately indexable portal pages: one title across
both would make each compete with the other for the same query. `scripts/static-docs-http.test.mjs`
asserts the two differ, so reusing one is a test failure rather than a silent regression.

**The root's card is `app/(home)/opengraph-image.tsx`, Next's file convention, not a second handler
under `app/og/`.** The existing route resolves its slug through `source.getPage()`, and the site
root is not a page in the docs collection, so it cannot serve `/` under any URL. The convention
buys two things a hand-written route would not: Next emits `og:image:width`, `og:image:height`,
`og:image:type` and `og:image:alt` beside the URL, and the file's position scopes the image to the
`(home)` route group, which holds only `/`. At the app root it would apply to `/docs/**` too, where
each page already generates a card of its own. The card itself, colours and 1200x630 size included,
is `renderOgImage` in `lib/og.tsx`, shared with the docs route so the two cannot drift apart;
nothing else would catch that, because an OG image is only ever seen in somebody else's feed. Next
serves it from `/opengraph-image-<hash>`, where the suffix is derived from the file's position in
`app/`, which is why the entry on the proxy's bypass list is a prefix test rather than an equality
one. A rejected alternative was pointing the root at `/og/docs/image.png`, the docs landing page's
card: it exists and is already prerendered, but its text comes from `content/docs/index.mdx`
frontmatter, so a writer editing that page would silently change what `/` looks like on X and in
Slack.

**No `title.template` in `app/layout.tsx`.** A site-wide `%s | Arbitrum docs` suffix is the
conventional shape and was rejected on two measurements, though only the first carries weight.
`content/docs/index.mdx` is titled "Arbitrum docs", so `/docs` would render "Arbitrum docs | Arbitrum
docs", and that reason stands on its own. The second reason is weaker than it first looks: the
longest frontmatter title across `content/docs` is 96 characters, not 105, and at 96 characters a
title is already well past the roughly 60 characters a search result shows, so a suffix costs nothing
on the handful of pages long enough to raise the concern. The suffix would instead land on the many
short titles that make up most of the tree, where it is brand value rather than truncation risk.
Adding a template later means giving `content/docs/index.mdx` (or any page that would otherwise
double the suffix) a `title.absolute`, which is an editorial pass and not a metadata change.

`app/not-found.tsx` already exported a title and a description and needed nothing. Every other
route under `app/` is a route handler or a metadata route and emits no document head at all.

**Every absolute URL a page publishes as metadata traces back to `getSiteUrl()` in
`lib/shared.ts`, and that helper throws rather than guessing.** It returns `NEXT_PUBLIC_SITE_URL`, falls back to `http://localhost:3000`
outside production, throws when `VERCEL_ENV` or `NEXT_PUBLIC_VERCEL_ENV` is `production` and the
variable is unset, and throws when a configured value does not parse as an absolute URL. The throw exists because `NEXT_PUBLIC_*` values are inlined at build time:
a production build with the variable missing would bake `http://localhost:3000` into the canonical
and social image URL of every page in the deployed output. Those pages then tell crawlers the
canonical copy lives on localhost, which is worse than emitting no canonical at all, and nothing
about the running site reveals it. Failing the build is the last cheap moment to catch it.

**The rule lives in `lib/site-url.mjs`, in plain JavaScript, and both `lib/shared.ts` and
`next.config.mjs` import it.** That split is not stylistic. `next.config.mjs` is the earliest thing
the build evaluates, which makes it the gate that always fires, and it cannot import TypeScript. It
is no longer the _only_ thing that fires: before FS-2689 dropped
`--experimental-build-mode=compile`, no page or layout module was evaluated at build time at all, so
`getSiteUrl()`'s throw in `lib/shared.ts` never ran during a build and `next.config.mjs` was the sole
enforcement point. Now that 1061 routes prerender, the docs pages among them (see
[static routing](#static-routing-under-docs)), the root layout's module scope does run at build and
would throw too. Keep both anyway: `next.config.mjs` is evaluated before any route is, so it is the
one check that does not depend on what a given build happens to render. The rule used to be
written out by hand in both files, which meant the copy with the tests was the backstop and the
copy without them was the gate, one edit away from silently diverging. One module imported by both
removes the question. A malformed value is caught in the same place and for the same reason: an
origin pasted without a scheme (`docs.arbitrum.io`) satisfies a presence check, then throws inside
`new URL()` at the root layout's module scope on the first request after promotion and 500s every
route, which is the unset failure again but worse, because the unset case at least fails the build.

`app/layout.tsx` calls `getSiteUrl()` at module scope for `metadataBase`, which keeps the failure a
module-load one rather than a per-request one for anything reached outside a build. The docs page calls it again to build the
canonical absolutely rather than leaning on `metadataBase` resolution, so the one value that a
wrong canonical depends on is read through the one helper that refuses to invent it. The helper imports
nothing but the rule module, and must stay that way: it is what lets `app/sitemap.ts` and
`app/robots.ts` use it without pulling `lib/source` toward a client bundle. `scripts/lib/site-url.test.mjs` covers it, calling the `.mjs` rule directly and
then checking both wrappers: `getSiteUrl()` in a subprocess with `--experimental-strip-types`,
because `node --test` cannot import TypeScript, and `next.config.mjs` by importing it under a
controlled environment, which is the case that pins the build failure itself.

**`RequestUpdateLink` is the one deliberate exception, and it should stay one.** It reads
`NEXT_PUBLIC_SITE_URL` directly (`components/RequestUpdateLink.tsx`) and falls back to the
site-relative path rather than to the helper's localhost. Its URL is not metadata: it goes into the
body of a GitHub issue that a person reads, and `/docs/stylus/quickstart` tells that person which
page the report is about, while `http://localhost:3000/docs/stylus/quickstart` is noise from
whoever happened to file it from a dev server. In production the two are identical, because the
build fails when the variable is unset. Do not "fix" this into a `getSiteUrl()` call.

`app/(home)/page.tsx` builds its canonical the same way, absolutely from `getSiteUrl()`, so no
route in the app leans on `metadataBase` resolution for the one tag a wrong origin ruins.

## Partials

Reusable `_`-prefixed fragments live in `content/partials/` — **outside** the doc collection `dir`
entirely, so they can never be routed. No glob exclusion is needed. Two consumption paths, both
tracked by the tooling:

**`<include>` directive** (build-time splice). Doc→partial includes use the root-anchored
`<include cwd>content/partials/…</include>` form, so moving a page never breaks its includes.

**Partial→partial includes must be file-relative** (`<include>../x.mdx</include>`). A partial may
be compiled outside the docs pipeline when ESM-imported, and there `fumadocs-mdx`'s `cwd` context
is undefined and crashes the build. `partials:check` enforces the distinction.

**Neither scanner sees code.** `parseIncludes` and `parsePartialImports` strip fenced blocks and
inline code spans before they match (`scripts/lib/strip-code.mjs`, the same helper `content:lint`
uses for every A rule), so a directive quoted as an example is not validated as a real include and
is not counted in the catalog's "used in" totals. `fumadocs-mdx` agrees at the other end:
`remarkInclude` visits JSX and directive nodes only, so a fenced `<include>` is a `code` node it
never expands. That is what lets the contribute guide print the syntax it teaches (FS-2723).

**ESM import** as an MDX component module — `import X from '@/content/partials/…/_x.mdx'` — is
supported by the tooling (`scripts/lib/partials.mjs` scans the importer roots) but **currently used
by no component.** The last consumer, `FloatingHoverModal`, was deleted as dead code.

Partials carry no frontmatter; `<include>` strips it, and the lint flags vestigial frontmatter.

**Two partials are generated, not written.** `content/partials/precompile-tables/*.mdx` comes from
`pnpm precompiles:generate`, and `content/partials/_reference-arbitrum-contract-addresses-partial.mdx`
from `pnpm contracts:generate` (the `@arbitrum/sdk` network registry plus
`scripts/data/contract-addresses.data.mjs`, every address normalised to its EIP-55 checksum because
`<AddressExplorerLink>` throws on a bad one). Each carries a do-not-edit marker at the top. Edit the
generator or its data file, never the `.mdx`. These two are also the only partials Prettier touches,
via the generators themselves; `.prettierignore` excludes `**/*.mdx` from `pnpm format`.

The contract-addresses partial is the one that still carries frontmatter, so `partials:check` warns
R3 on it. The generator reproduces it rather than dropping it: the title and summary in `CATALOG.md`
are read from those keys, so removing them is a catalog change, not a formatting one, and belongs in
its own commit.

`CATALOG.md` and `manifest.json` are generated — never hand-edit them. Curate titles, summaries,
and tags in the optional `content/partials/registry.json`.

## Global variables

Writer-edited values live in `content/vars.json`, are validated by the Zod schema in
`content/vars.ts`, and render in MDX via `<Var name="…" />`. A bad value fails at module load.

**Why two files.** `vars.json` is plain JSON, so writing a value needs no TypeScript. `vars.ts`
validates it with a Zod `strictObject` at module load, so a missing or mistyped key throws
immediately with a field-level error — in the `pnpm dev` console and in CI.

The strictness is load-bearing. A plain `z.object` silently strips keys present in the JSON but
absent from the schema, so `<Var>` renders the literal string `undefined` into the page. That is
how 27 variables once came to render `undefined` across 85 pages.

Adding a **new** variable takes both files: the key in `vars.json` **and** its type in the
`varsSchema` in `vars.ts`. Miss either side and the gate fails.

`.mdx` never passes through `tsc`, so the `VarKey` type does not protect MDX callers and
`types:check` exits 0 on a page full of broken variables. **`vars:check` is the only gate that
catches a `<Var name>` with no matching key.**

Values started as a copy of the Docusaurus site's `src/resources/globalVars.js`. That site is
archived, so `content/vars.json` is now the only copy and there is nothing left to keep it in sync
with.

**`<Var>` does not render inside code.** MDX does not evaluate components inside a fenced code
block or an inline code span, so a `<Var name="…" />` placed there ships as the literal tag text.
Neither `vars:check` nor `types:check` sees this, since both only prove the variable exists, not
where it's used. `content-lint` rule A6 catches it. Fix a finding by removing the code span if the
value was never code to begin with, which is the common case; a `docker run` command a reader copies
genuinely needs the value spelled out, so hardcode it there and put the live `<Var>` in the prose
next to it.

The hardcoded copies are kept in step by `pnpm nitro:check-release`, which rewrites the **outgoing**
`latestNitroNodeImage` value when it bumps the variable, but only in a file that opts in by carrying
the marker `{/* sync-with-var: latestNitroNodeImage */}`. Two weaker rules were tried and rejected:

- Flagging every `offchainlabs/nitro-node:` literal that is not the current value. `content/` holds
  47 older tags pinned deliberately in historical examples, so the rule would open with 47 findings,
  none of them defects, in a check that blocks every PR.
- Rewriting every occurrence of the outgoing value with no marker. That looks safe, since the
  outgoing value can only ever be a copy of what was current, and it is not:
  `content/docs/run-a-node/arbos-releases/*.mdx` pin the minimum Nitro version for each ArbOS
  release, and `arbos61.mdx` pins `v3.11.3-beb2108`, which _is_ the current image right up until the
  next release ships. An unattended rewrite would make that page claim ArbOS 61 requires a build
  published after it. A version stated as a fact about the past and a version stated as "the latest"
  are the same string, and nothing but an explicit marker tells them apart.

So do not put the marker on a page that states a Nitro version historically.

The root `dependencies.json` is **not** part of that machinery. It is a verbatim snapshot of
upstream `arbitrum-docs`' release ledger for five projects (`nitro`, `stylus-sdk`, `orbit-sdk`,
`nitro-contracts`, `token-bridge-contracts`), salvaged under FS-2702 so the per-project detail
survives that repo's archival. Nothing here reads it, its version numbers are frozen as of the
copy, and `content/vars.json`'s `nitroVersionTag` is the live Nitro pin wherever the two
disagree. Its own `_note` key says so in the file. What extending `check-nitro-release.mjs` to
the other four projects would take is written up in that file's commit message; the short
version is that the Docker-Hub tag resolution at the heart of the script is Nitro-specific and
does not generalize.

### A variable in a link destination is a placeholder, not a component

`<Var>` cannot be used in a link destination, and nothing about the failure is loud:

```mdx
[Interface](https://github.com/OffchainLabs/<Var name="nitroRepositorySlug" />/blob/x.sol)
```

CommonMark reads an unbracketed link destination as one raw token that may not contain a space, and
the tag holds two. The resource never parses, so the whole construct falls back to literal text: the
reader sees the `[Interface](…)` brackets, with only the bare URL prefix before the first `<Var>`
autolinked by GFM, and there is no working `<a>` for the intended target at all. Seventy-three links
across five pages shipped that way with every gate green (FS-2725), because `vars:check` only proves
the key exists, `check-links` skips an external destination, and rule A6 reads code fences and spans.

The destination takes a `{var:name}` placeholder instead. It holds no space, so the link parses
normally and the braces survive verbatim in the mdast `link` node's `url`:

```mdx
[Interface](https://github.com/OffchainLabs/{var:nitroRepositorySlug}/blob/{var:nitroVersionTag}/x.sol)
```

`remarkVarLinks` (`lib/var-links.mjs`) expands it. What follows from where it is wired:

- It sits in `lib/mdx-options.mjs`, the transform set the site and the fragment half of
  `check-links` share, so `scripts/lib/doc-anchors.mjs` validates the `#anchor` of an expanded URL.
  The path half is a separate code path: `scripts/lib/doc-links.mjs` reads destinations out of the
  raw MDX with regexes, because it also has to rewrite them in place for `pnpm move-doc`, so it
  expands a placeholder itself through `expandRefUrl`, which calls the plugin's own
  `expandVarPlaceholders`. Without that an internal destination written with a placeholder was
  reported broken even though the built page carried a working URL. One expansion function, two
  callers. A component that built the `href` itself would be invisible to both, which is the blind
  spot rule `A7` already exists for.
- `move-doc` resolves such a link but never rewrites it. `renderRef` writes a literal path, which
  would bake the variable's current value into the file, so a destination holding `{var:` is passed
  over the way a `cwd` include is.
- It runs after fumadocs-mdx splices `<include>`, so a placeholder inside a partial expands too.
  Verified by adding one to an included partial and reading the served HTML, not inferred from the
  plugin order.
- It rewrites the url and title of a `link`, `image` or `definition` node, and the `href`, `to` and
  `src` attributes of a JSX element. The `image` case only reaches a remote src: fumadocs runs its
  own remark-image first, so a local src is already an import of the written path by the time this
  plugin sees the tree, and a placeholder in one fails the build on a file that does not exist.
  Nothing silent survives either way, and `pnpm images:presence` blocks a markdown image with a
  remote src regardless.
- A placeholder is expanded nowhere else, and the two contexts a writer might reach for by mistake
  both fail loudly rather than shipping. In prose the MDX compiler reads `{…}` as an expression and
  throws `Could not parse expression with acorn`, so the page cannot build; use `<Var name="…" />`
  there, which is what it is for. In a fenced block or an inline code span it stays literal, which
  is correct, and matches what `<Var>` does in the same place.

The `var:` prefix is what lets the gate be strict. A bare `{name}` is indistinguishable from a URL
documenting a path template (`…/{chainId}/…`), so `vars:check` would have to choose between letting
a mistyped name ship and failing on a real template. With the prefix, `scripts/lib/vars-audit.mjs`
counts a placeholder as a variable reference and an unknown name is unambiguously a mistake.

One thing does not follow the component: **a `vars.json` edit does not reach a placeholder until the
dev server restarts.** fumadocs-mdx caches one processor per collection, so `readVars()` runs once at
attach time, while `<Var>` reads the imported `content/vars.ts` on every render. Measured on `pnpm
dev`: with one page holding both forms, changing `nitroVersionTag` updated the prose immediately and
left the link on the old value until a restart. A production build reads the file once and is
unaffected.

An unknown name is left in place rather than thrown on, which matches what `<Var>` does with one:
the defect reaches the page and `vars:check` fails on it. Throwing inside a plugin that loads before
any page is rendered would take the whole site down for a single typo. `content:lint` rule `A11`
blocks the old syntax, and a placeholder whose name is not an identifier, so neither can come back.

### This repository's own URL has one owner

`content/vars.json` owns the docs repository's GitHub identity, as `docsRepositoryUrl` and
`docsRepositoryBranch`. Both sides read it from there: `gitConfig` in `lib/shared.ts` composes the
edit link on every docs page and the "Request an update" issue link, and the contribute guide writes
its own links as `{var:docsRepositoryUrl}/blob/{var:docsRepositoryBranch}/…` destinations. The
"know more tools?" partial writes the seventh, `{var:docsRepositoryUrl}/issues/new`, which offers a
reader the same issue tracker the "Request an update" button beside it opens. It named the other
repository until the round 1 review of FS-2733 found it.

Before FS-2733 the guide hardcoded six of those URLs beside a comment asking a human to retarget
them by hand, because `<Var>` does not work in a destination and FS-2725 declined to move them onto
a variable while `lib/shared.ts` held a second copy of the same string. `check-links` skips every
external destination, so a repository rename would have left six dead links on `/docs/contribute`
with no gate turning red. The two comments are gone; the mechanism replaces them.

**`docsRepositoryUrl` is the one value that flips at cutover**, when this repository takes over the
`OffchainLabs/arbitrum-docs` name and URL. Editing that one string moves the content links and the
two composed links together. `docsRepositoryBranch` does not flip. One link is deliberately already
on the far side of the flip: the "fork the Arbitrum docs repo" step names `arbitrum-docs` today,
because that is where a contributor forks from, and the partial carries an inline comment saying so.
The rest cannot follow yet, since the files they name do not exist in that repository until cutover.

Three details are load-bearing:

- `gitConfig` is `{ url, branch }`, not `{ user, repo, branch }`. Both call sites joined the first
  two immediately, so the split only offered a way for the halves to disagree.
- `lib/shared.ts` imports `content/vars.json` **with an explicit `with { type: 'json' }`
  attribute**. `scripts/lib/shared.test.mjs`, `scripts/lib/contribute-repo-links.test.mjs` and
  `scripts/static-docs-http.test.mjs` all import that module as `.ts` under `node --test`, where
  Node 22 strips the types but still rejects a bare JSON import with `ERR_IMPORT_ATTRIBUTE_MISSING`.
  `content/vars.ts` keeps its plain import, because nothing runs that file under bare Node.
- It imports the JSON, never `content/vars.ts`, which would pull Zod into the module a client
  component (`components/sidebar-resource-links.tsx`) imports from. Measured either way: with the
  JSON import, `pnpm build` produced byte-identical client chunks (16,618,175 bytes over 379 files,
  the chunk carrying `SidebarResourceLinks` still 2,530 bytes), because the two keys are read in
  server components only and get inlined there. **State that measurement as key names**, plus
  `docsRepositoryUrl`'s value: no `vars.json` key name appears under `.next/static`, and neither
  does that URL. Do not state it as "no value appears", which does not reproduce. Nine of the
  thirty-six string values are short or generic enough to match unrelated code as substrings, among
  them `0.02`, `1.91`, `nitro`, and `docsRepositoryBranch`'s own value, `main`. A value grep
  therefore cannot tell a leak from a coincidence, and the key names can.

`proxy.ts` imports `lib/shared.ts` too, for `docsRoute`, `docsContentRoute` and `getSiteUrl`, so
that module's closure is the second consumer to weigh before importing anything heavier here.
Nothing arrived in it: the traced proxy closure is 98 files and 1,782,299 bytes
(`.next/server/middleware.js.nft.json`), it does not list `content/vars.json`, and no traced file
contains a `vars.json` key name or either new value, because `gitConfig` goes unused there and is
dropped. Had it not been, the whole JSON is 2,653 bytes against that 1.78 MB, about 0.15 percent.
CLAUDE.md quotes that closure size as load-bearing, so weigh both consumers, not just the client
chunks, before importing anything heavier into `lib/shared.ts`.

Two tests hold the agreement. `scripts/lib/contribute-repo-links.test.mjs` expands the partial's
destinations and asserts each one belongs to the repository `gitConfig` names, which also proves the
code value and the JSON value are the same string with no server running. Its third assertion is
repository-wide: no `.mdx` file anywhere under `content/` may write a docs-repository URL out in
full, under either the current name or the `arbitrum-docs` name this repository takes over, with one
documented exception for the fork step. That rule is what a check pinned to the contribute guide
could not give, and it is what caught the reader-facing issue link in
`content/partials/_know-more-tools-box-partial.mdx`. The HTTP half in
`scripts/static-docs-http.test.mjs` fetches `/docs/contribute` and applies the same rule to the
rendered hrefs, which is what proves the placeholders expanded rather than shipping as braces.

`docsRepositoryBranch` is `z.string().min(1)`. An empty branch renders `…/blob//CONTRIBUTE.md`,
which GitHub redirects to `…/tree/CONTRIBUTE.md` and answers 404, and no other gate sees it:
`vars:check` only proves the key exists and `check-links` skips every external destination. A
trailing slash on `docsRepositoryUrl` is deliberately not rejected, because the doubled slash it
produces is answered 200.

`.github/pull_request_template.md` still hardcodes two of these URLs. GitHub renders that file, not
this site, so no mechanism here reaches it; flip those two by hand at cutover.

### Announcement banner

`app/layout.tsx` renders Fumadocs' `Banner` above everything else in `RootProvider`, which puts it
above the navbar because every layout's header lives inside `{children}`. Its text, link, enabled
flag, and id all come from `vars.json`, so writers change the message without touching code. It
replaces the Docusaurus `announcementBar`.

Three things about it are not obvious:

- **The keys are not `<Var>` substitutions.** `pnpm vars:check` reports them as configured but
  unreferenced in MDX. That warning is expected for this block and is not a defect.
- **`announcementId` is the dismissal key, and dismissal is permanent.** Fumadocs writes
  `nd-banner-<base32(id)>` to the viewer's `localStorage` on close and injects a script that hides
  the banner before hydration. `localStorage` outlives the tab and the session, so a reader who
  closes the banner is done with that id on that browser for good. The ticket asked for "per
  session"; this is stronger, and it is what Fumadocs' component does. Reusing an id for a new
  message therefore hides it from everyone who dismissed the old one.
- **`announcementLinkHref` is gated.** `pnpm vars:check` requires an `https` URL or a root-absolute
  internal path that resolves to a page or a `public/` file, with the rule in
  `scripts/lib/announcement-link.mjs` and its tests beside it. `check-links` walks MDX only and this
  value lives in JSON, so without that check the most visible link on the site is the one nothing
  validates. Relative hrefs are rejected rather than resolved: the banner renders on every route, so
  there is no page to resolve them against.
- **`height` has to be a real length.** The prop lands in an inline style and in
  `--fd-banner-height`, which the docs and notebook containers feed into `calc()` and a sticky
  `top`. `auto` breaks the grid. The message fits one line from 640px up and wraps to two below, so
  the layout passes a custom property that a media query switches between `3rem` and `4rem` rather
  than a constant.
- **The height and the text are coupled, and only the text is writer-facing.** The heights above
  were chosen for a message of the current length, and that message is a `vars.json` value a writer
  is meant to change without a code review. `3rem` holds two lines of `text-sm`, `4rem` holds three,
  and a long enough message overflows. No gate sees this, because the text lives in JSON and the
  height lives in TSX. The constraint is therefore stated in the [README](README.md#announcement-banner)
  next to the key, as a budget of roughly 140 characters for `announcementText` plus
  `announcementLinkText`. A character gate was considered and rejected: any threshold would be a
  guess at Aeonik's metrics, and a gate that fires on a message which actually renders fine is worse
  than the prose. Measuring the rendered bar and writing `--fd-banner-height` from a
  `ResizeObserver` would remove the coupling properly; it needs a client component and was out of
  scope here.
- **`announcementId` is constrained by a pattern in the schema.** Banner writes it into the
  element's `id` and into a generated `.<key> #<id> { display: none }` rule. The class half is
  `nd-banner-<base32(id)>` and is always a legal identifier; the `#<id>` half is the raw value. A
  space or a leading digit makes that selector match nothing, so closing the banner would look like
  it worked and the banner would return on the next page load, silently. `content/vars.ts` requires
  `^[A-Za-z][A-Za-z0-9_-]*$` so the failure happens at module load instead.

## Redirects

Every redirect lives in `redirects.config.mjs`, consumed by `next.config.mjs`'s `redirects()`.
Next compiles them into `.next/routes-manifest.json`, which Vercel reads directly — **there is no
`vercel.json` here, and adding one would be a second source of truth, not a mirror.** Vercel applies
`vercel.json` routes before framework routes, so it would silently shadow `redirects.config.mjs`.

The Docusaurus site needed two copies (a client-redirects plugin for in-app navigation plus a synced
`vercel.json` for the edge). Next needs one.

`redirects()` runs **before** `proxy.ts`, so a redirected URL gets markdown negotiation on the
destination, not on the first hop.

The `AUTO-GENERATED` block in `redirects.config.mjs` is written by `pnpm move-doc`; never hand-edit
between its markers. The rest of the file, and `redirects.legacy.mjs` beside it, are hand-maintained.

**Moved pages.** `pnpm move-doc <from> <to>` writes the old→new URL between the `AUTO-GENERATED`
markers.

**It then retargets the legacy destination overlay, as its last step.**
`scripts/lib/legacy-redirects.mjs` keeps two hand-written maps naming this site's pages,
`MANUAL_DESTINATIONS` and `SECTION_LANDINGS`, as **site URLs** (`/docs/…`, sometimes with an
`#anchor`) rather than content-relative paths. `scripts/lib/legacy-destinations.mjs` retargets both.
Before this, moving a page named in either left a legacy `docs.arbitrum.io` URL pointing at a 404
until the tripwire in `scripts/lib/legacy-redirects.test.mjs` ("every hand-written destination still
names a live page") failed in whatever PR ran `pnpm test` next.

Three things about that rewrite are load-bearing, and each exists because the alternative fails
quietly:

- **It edits only inside the two named `new Map([…])` literals.** `legacy-redirects.mjs` also
  declares `SECTION_RENAMES`, an array of URL-shaped strings. A whole-file match for a page's URL
  could rewrite one of those while reporting itself on the CLI as a destination change.
- **A missed match aborts the step.** The rewrite is textual and single-quote-only, so reformatting
  the module to double quotes, or writing an entry as a template literal, would match nothing and
  leave the stale destination in place, which is the original bug again with no warning. After
  rewriting, `legacy-destinations` imports the module and checks its substitution count against the
  parsed maps; a disagreement throws and names the URL.
- **It runs last and writes both maps or neither.** Every read, rewrite, verification and Prettier
  pass happens before the first write, and `move-doc` calls it after the redirect is appended, so a
  formatter or parse failure cannot cost the redirect or leave one map retargeted and the other not.

Three further details come from the data:

- **It works in URLs, so `move-doc` hands it `fromMeta.url`/`toMeta.url`.** A partial (no URL) and a
  move that does not change the URL are both no-ops.
- **It tells values from keys by position, not by a trailing `:`.** A `Map` entry is `[key, value]`,
  so the value is the string the `]` follows: `'…'(?=\s*,?\s*\])`. Both Prettier layouts (one line,
  and the value wrapped onto its own line) satisfy it. An `#anchor` on a destination is carried
  across; the closing quote sits immediately after the URL, so `/docs/get-started` cannot match
  inside `/docs/get-started/child`.
- **It does not retarget `redirects.legacy.mjs` itself.** Readers do not need it: `move-doc` has
  already appended `oldUrl → newUrl` to `redirects.config.mjs`, and Next serves one redirect per
  request, so a legacy URL still reaches the moved page in two hops. `redirects:check` does care.
  `redirects.legacy.mjs` still names the old URL as its destination, and the check compares a
  destination against the routable pages without ever following a second hop, so every legacy source
  that named the moved page reports `DEAD`. That file is hand-maintained, so the fix is to retarget
  those entries or accept the extra hop. The same one-hop reading reaches the `AUTO-GENERATED` block:
  an earlier move's redirect whose destination is the page just moved now chains and reports `DEAD`
  alongside them. Retarget it to the new URL. The step prints a note saying all of this.
- **The chained `AUTO-GENERATED` entry gets its own note, and only when there is one.** The block
  holds four entries in total, so a move of any other page has nothing chained to it: asserting the
  chain unconditionally was false for 64 of the 68 pages the two maps name, and sent the mover
  looking for a line that does not exist. `findChainedAutoRedirects` reads `redirects.config.mjs`
  between the two markers, matches `source` then `destination` (the order `appendRedirect` writes
  and Prettier preserves when it wraps), compares the destination for exact equality so a move of
  `/docs/run-a-node` cannot claim the entry pointing at `/docs/run-a-node/run-batch-poster`, and
  names the source URL(s) to retarget. The entry `move-doc` appended moments earlier cannot match
  itself, because its destination is the _new_ URL. That note is **not** gated on either legacy map
  having changed, unlike the `redirects.legacy.mjs` note above it: a chained entry is an earlier
  move's business, not the maps', and a page no legacy map names would otherwise chain in silence.

**This step was written to outlive the legacy redirect generator, and did.** The derivation half of
that system, everything that read an arbitrum-docs checkout, was deleted in FS-2706 when that repo
was archived. The two maps were not: `docs.arbitrum.io` URLs have to keep resolving forever. Because
`legacy-destinations.mjs` imports only those two named exports, rewrites only the two literals that
declare them, and reads nothing else, the generator's deletion cost it no change at all. Should the
maps ever move to a different module, the textual rewrite finds nothing and the cross-check throws,
rather than the step silently skipping.

**`VERSIONED` in `lib/versions-constants.ts` is still on the mover, but it is no longer silent.**
That registry keys the partial versioning registry by canonical slug (`'run-a-node/start-here'`) and
`move-doc` does not touch it, so moving a versioned page still leaves a dead key. What changed is
the consequence: FS-2698 added `scripts/versions-routing.test.mjs`, which asserts that every key
names a live page, so a dead key now fails `pnpm test`, a blocking gate. It used to pass 346/346
with `lib/versions.ts` untouched, and the page silently lost its version dropdown while its
archives became unreachable. `scripts/versioned-docs-check.mjs` is still only an advisory about
uncommitted edits and still always exits 0; it is not what catches this. Retargeting the key is a
judgement call (`archivePath` mirrors the old slug on every current entry but is not required to),
so after moving a versioned page, retarget its `VERSIONED` key by hand.

**Legacy `docs.arbitrum.io` URLs.** `redirects.legacy.mjs` holds 853 of them. Legacy URLs were
served at the site root (`/stylus/using-cli`) and this site serves docs under `/docs`, so sources
stay root-level (that is what real inbound links look like) and destinations point at `/docs/…`. The
file is committed and **hand-maintained**: add an entry by writing it, in source order, and prove the
destination with `pnpm redirects:check`.

It was originally generated, from two inputs that no longer exist: the Docusaurus repo's own
`vercel.json` redirect sources, and every canonical page URL derived from its `docs/` tree by
reimplementing Docusaurus routing. That generator, and the `pnpm redirects:legacy` script around it,
were deleted in FS-2706 along with the rest of the upstream coupling. What survives is
`scripts/lib/legacy-redirects.mjs`: `MANUAL_DESTINATIONS`, `SECTION_LANDINGS`, `SECTION_RENAMES`, the
content-tree inventory the tripwire resolves against, and the record of the resolution order below.

**The resolution order is how every committed entry was decided, and how a new one should be.** Each
legacy URL took the first rule that matched, and a rule that could not decide declined rather than
guessing.

1. **`MANUAL_DESTINATIONS`**, a hand-verified legacy destination → local page, confirmed by comparing
   the upstream page's frontmatter title against the local candidates. A value may carry an
   `#anchor`; the page part has to resolve.
2. **Self-URL**, where the legacy path still names a live page here under `/docs`. This resolved most of
   the canonical URLs, which had only ever needed the `/docs` prefix.
3. **`SECTION_RENAMES`**, whole sections that moved wholesale (`/run-arbitrum-node` →
   `/run-a-node`). Deep restructures are deliberately absent: their pages moved individually, so a
   prefix rule would produce confidently-wrong destinations.
4. **Exact title**, when exactly one local page carried the upstream page's frontmatter title
   verbatim. Ahead of the basename, because a title identifies a page where a basename only suggests
   one. This site pairs a `features/…/choose-X` page answering "why would I want X" with a
   `configuration/…/X` how-to, and the two often share a basename or differ only by a `config-`
   prefix; the basename alone kept picking the "why" half, so a reader after a procedure landed on a
   page that has none. It declined when two local pages shared the title, _and_ when two upstream
   pages shared it, for the same reason rule 5 does: there the legacy path was doing the
   disambiguating and the title cannot.
5. **Basename fallback**, accepted only when exactly one local page carried that slug _and_ the
   basename was unique upstream too.
6. **`SECTION_LANDINGS`**, the nearest live section, for a page upstream had and this site never
   ported. Not an equivalence, and last on purpose: the day the page is ported, rule 2 matches first
   and the entry goes inert on its own.

**The guiding rule: a redirect to a plausible-but-wrong page is worse than a 404.** It silently
sends readers somewhere wrong, and `redirects:check` cannot catch it, because the destination
exists. Anything no rule resolved was left unmapped rather than pointed at a plausible page, and the
same judgement applies to a hand-added entry.

**A source that names a live route here must never be added.** Next runs `redirects()` before
anything renders, so such a redirect wins over the route and makes it unreachable. The site root,
`/llms*`, `/og`, `/api`, `/img`, the `public/` asset directories and the icon and PDF files are all
in that category; `redirects:check` reports one as `SHADOWED`.

**`MANUAL_DESTINATIONS` and `SECTION_LANDINGS` are hand-written, so a test pins them against the
content tree.** An orphaned entry would otherwise rot silently into a redirect to a 404.
`pnpm test` walks `content/docs` and asserts every non-external value in both maps still resolves.
Since the generator was deleted this is the only automated check on either map that runs without a
server, which is why `pnpm move-doc` retargets both in the same run as the move (see
[Moved pages](#redirects)); the test now guards against a hand edit and against a page leaving the
tree some other way, not against the mover.

`pnpm redirects:check` validates every destination against `/llms.txt` — the router's own page
list — and fails on a dead destination or a source that shadows a live page. It needs the site
running, so run it with `pnpm dev` up, or point it at any other origin with `--base-url`.

**CI runs it in the `Build` job**, as a step after `pnpm build`: it starts `next start`, polls
`/llms.txt` until the server answers, runs the check, and kills the server on the way out. The
build is already happening in that job, so the whole step costs about three seconds. It is
non-blocking only because that job is; promoting `Build` into `Gates` promotes this with it.

`next start` directly, not `pnpm start`: backgrounding the pnpm script makes `$!` the wrapper's
PID, so the cleanup trap kills the wrapper and leaves the Next server orphaned on port 3000.

**It deliberately does not check a Vercel preview, and should not be changed back.** The obvious
design, a `deployment_status` workflow pointed at the PR's preview URL, was built on `fs-2675` and
abandoned once this repository went public. `deployment_status` runs from the default branch with
full secrets access, so checking out the PR's commit and running its copy of `redirects-check.mjs`
executes contributor code beside whatever secret the step holds. The secret is the worse half:
`VERCEL_AUTOMATION_BYPASS_SECRET` bypasses Deployment Protection on **every** deployment in the
project, production included, and Vercel injects it into every build, so creating it at all hands it
to any fork preview a maintainer authorizes. A localhost server needs no credential, so a fork PR is
checked exactly like a branch PR.

The site does not have to be a _deployed_ site for the router to be the authority on what is
routable. That is the whole trick.

## Routing and `proxy.ts`

Single locale, no i18n. Pages live directly under `content/docs/…` and serve at `/docs/…`. There is
no `[lang]` route segment and no locale middleware; `lib/i18n.ts` was deleted on 2026-08-18 along
with the `ja` and `zh-CN` trees.

`proxy.ts` does exactly four things, in this order:

1. A 308 for the **legacy `?v=<id>`** archive selector, onto the path form FS-2698 introduced
   (`/docs/<slug>/<id>`, and `/docs/<slug>/<id>.md` when the request carried the markdown suffix).
   An id naming no registered archive has the param dropped and nothing else, because the contract
   has always been that an unknown version falls back to Latest, and `dynamicParams = false` would
   now 404 it. This runs **before** tracking, deliberately: a 308 delivers no markdown, the
   reader's follow-up request is counted on its own, and counting the hop would file an archive
   read under the live page's path.
2. **Request tracking** for markdown and `llms*.txt` fetches, production only (below).
3. An explicit **bypass list** of routes served verbatim: `/_next/`, `/img/`, `/favicon.ico`,
   `/icon.png`, `/apple-icon.png`, `/nitro-whitepaper.pdf`, `/audit-reports/`, `/data/`,
   `/.well-known/`, `/sitemap.xml`, `/robots.txt`, `/llms*`, `/og/`, `/api/`.
4. `.md`-suffix rewrites plus `Accept: text/markdown` content negotiation to the markdown route.
   Both patterns are written over the whole path under `/docs`, which is why an archive needs no
   rewrite of its own (see [Partial versioning](#partial-versioning)).

**A new top-level route belongs in that bypass list**, or markdown negotiation will try to rewrite
it. `proxy.ts` exports no `config.matcher`, and Next's proxy reference is explicit that without one
the proxy runs on every request, `public/` assets included, so nothing else keeps a static file out
of the rewrite branches.

Re-adding localization means restoring `defineI18n`, the `i18n` argument to `loader()`, a `[lang]`
segment, and `createI18nMiddleware`.

### `/.well-known/` and the MCP discovery card

`public/.well-known/mcp/server-card.json` is the MCP server discovery card, ported verbatim from
upstream `static/.well-known/mcp/server-card.json` in OffchainLabs/arbitrum-docs (FS-2704). It is
the document a client finds when it has only the site origin and wants to know whether the docs
expose an MCP server: it names `https://mcp.inkeep.com/offchainlabs/mcp` as a `streamable-http`
endpoint, which is the same Inkeep service behind the site's search. Without it, a discovery fetch
of `/.well-known/mcp/server-card.json` against docs.arbitrum.io 404s after cutover while the search
it advertises works, which is an inconsistency rather than a decision.

The path is a well-known URI (RFC 8615), so it is fixed and cannot be moved. Two consequences:

- **It is on the bypass list**, not by the convention that covers `/sitemap.xml` and `/data/`, but
  because a discovery client sends whatever `Accept` header it likes and must still get the JSON on
  disk. The rewrite patterns are anchored at `/docs` today, so the bypass is defence in depth, and
  the assertion that it holds is in `scripts/static-docs-http.test.mjs`, which requests the card
  under `Accept: text/markdown` as well as `application/json`.
- **The card is untracked.** `pathInfo()` in `lib/llms-tracking.ts` classifies it as `ignored`,
  which its tests pin: a discovery fetch is not a markdown read and must not join the
  `llms_file_fetched` series.

**Nothing regenerates or checks this file.** It is a hand-copied snapshot of somebody else's
document, so an upstream edit to the card goes unnoticed here. Its two facts that can rot are the
endpoint URL and the transport type; both were confirmed live when it landed, by sending an MCP
`initialize` to the endpoint. Upstream's `capabilities` block lists `tools` only, while the live
server also advertises `prompts` and `resources`; the copy stays byte-identical to upstream anyway,
because capabilities are negotiated at `initialize` and a divergent copy would be harder to re-sync
than it is worth.

### Request tracking

`proxy.ts` also records who fetches the markdown, continuing the `llms_file_fetched` PostHog event
upstream's `middleware.ts` produced. The point is to answer "which pages are AI assistants and
crawlers actually reading", which server logs alone do not.

**It runs before the bypass list**, because `/llms.txt`, `/llms-full.txt` and the `/llms.mdx/`
mirrors are all in that list and are exactly the fetches worth counting. It runs **after** the
legacy `?v=` redirect, for the opposite reason: that branch answers with a 308 and no body.

Four request shapes are tracked, and the classification lives in `lib/llms-tracking.ts`:

| Request                                     | Tracked as        | `file_type` |
| ------------------------------------------- | ----------------- | ----------- |
| `/llms.txt`, `/llms-full.txt`               | as-is             | `index`     |
| `/docs/<slug>.md`                           | as-is             | `page`      |
| `/llms.mdx/docs/<slug>/content.md`          | `/docs/<slug>.md` | `page`      |
| `/docs/<slug>` with `Accept: text/markdown` | `/docs/<slug>.md` | `page`      |

All three markdown shapes normalise to the one canonical `.md` path, so a page's fetches are one
number rather than three. **Each request is counted once:** a Next rewrite does not re-enter the
proxy, so `/docs/x.md` fires one event, not a second one for the mirror it rewrites to. Neither a
`.md` on a legacy URL nor a legacy `?v=` link is tracked, because both are answered with a redirect
and the destination request is tracked instead.

**Archives need no rule of their own.** An archived version is `/docs/<slug>/<id>`, so its three
markdown shapes are the rows above with the version id inside the slug, and they normalise through
the same code to `/docs/<slug>/<id>.md`. That is a different series from the live page's
`/docs/<slug>.md`, which is the point: "who is reading the ArbOS 20 archive" is a question worth
being able to answer. `scripts/lib/llms-tracking.test.mjs` pins it, since nothing in
`lib/llms-tracking.ts` mentions versions and the behaviour is therefore easy to lose.

Two upstream rules are dropped: the `/sdk/` exclusion (there is no `/sdk` route here) and tracking
of `.md` outside the docs tree.

**Production only.** Nothing is sent unless `VERCEL_ENV === 'production'`, so local development and
preview deployments stay out of the numbers and need no key. The key is `NEXT_PUBLIC_POSTHOG_KEY`,
the same publishable `phc_` token `lib/posthog.ts` uses, posted to the same `us.i.posthog.com` host.

**Tracking can never break a response.** The capture is handed to `event.waitUntil()` so the
response is not held for it, and every failure path is caught and logged. A missing key logs once
per request and drops the event. A **rejected** event is logged too, which needs its own line of
code: `fetch` rejects only on a network failure, so a 401 from a revoked project token resolves
normally, and without a `response.ok` check it would read exactly like no traffic at all.

**Schedule it with the `NextFetchEvent` Next passes as the proxy's second argument, never with
`waitUntil` from `@vercel/functions`.** That helper resolves the request context through
`globalThis[Symbol.for('@vercel/request-context')]`; when the symbol is absent its `getContext()`
returns `{}`, the call becomes `undefined?.(promise)`, and the promise is dropped with no error, no
log and no type error. **Next 16 does not install that symbol** (it installs
`@next/request-context`), so the capture would be at the mercy of whether the invocation happened to
outlive the response. Upstream's middleware used the framework's event for the same reason.

Nothing catches that locally, which is what makes it worth a paragraph: the promise chain starts
executing the moment it is constructed, so in `next dev` the fetch completes either way and an
end-to-end check passes while production loses events. `waitUntil` only extends the runtime's
lifetime past the response. Two tests in `scripts/lib/llms-tracking.test.mjs` assert the wiring
directly, because no runtime check can.

**The `distinct_id` is pseudonymous, not anonymous.** `buildTrackingPayload` hashes the client IP
with a UTC daily salt and sends only the hash; the raw address is never in the payload. Rotating the
salt daily prevents linking a reader across days, while one client's requests within a day still
collapse into a single PostHog person rather than one per hit. **It does not prevent re-identification:**
the salt is a public date string, so the whole IPv4 space can be hashed against it in seconds and a
stored id matched back to an address. Treat the id as personal data. Making it genuinely one-way
needs a secret salt and a decision about the unset case, which is deliberately left as follow-up
rather than half-built here.

A request with no `x-forwarded-for` gets a random id instead of the hash of the empty string, which
is a constant and would pile every such request onto one shared person that reads as a single
extraordinarily busy client. **That branch, and only that branch, also sets
`$process_person_profile: false`,** because a unique id per request would otherwise mint a person
profile per request and none of them could ever be related to anything. On the hashed path the
profile is the point: it is what makes "how many distinct crawlers fetched this page today"
answerable, at the cost of one profile per client per day, and it is upstream's behaviour.

**Tracking applies exactly the condition the negotiation rewrite applies, and no more.** That
rewrite is `/docs{/*path}`, which matches dotted slugs, so requiring a dot-free path in
`lib/llms-tracking.ts` made a slug like `/docs/v1.2/guide` serve markdown and record nothing. The
proxy cannot check that a page exists, since it cannot import `lib/source`, so this can track a
request that 404s, exactly as the `.md` branch already does for `/docs/nope.md`. That is the right
way round: an overcount shows up in PostHog as a `file` value nobody recognises, an undercount
shows up as silence.

**The `$current_url` origin comes from `getSiteUrl()`,** not from `request.nextUrl.origin`. A
production deployment answers on its `*.vercel.app` alias as well as on the custom domain, so the
request origin would record two `$current_url` values for one page and split the series. It also
keeps the site-URL rule in the one module that owns it (see [Page metadata](#page-metadata)).

`lib/llms-tracking.ts` is **deliberately import-free**, including of `lib/shared.ts`, so that
`scripts/lib/llms-tracking.test.mjs` can import it directly under `node --test` using Node 22's
native type stripping. That is what lets `pnpm test` exercise the exact module `proxy.ts` runs
instead of a copy that would drift from it. The price is two local copies of the route constants;
`proxy.ts` pins them with two `satisfies` statements, so moving `docsRoute` or `docsContentRoute`
without mirroring it fails `types:check`.

### `/sitemap.xml` and `/robots.txt`

Both are Next **metadata routes** (`app/sitemap.ts`, `app/robots.ts`), file conventions rather than
route handlers, so there is no `route.ts` and no hand-written XML. Neither sets `revalidate`: a
metadata route with no request-time input is already cached at build time by default.

**Both read the deployed origin through `getSiteUrl()`** (see [Page metadata](#page-metadata)),
the same helper behind `metadataBase` in `app/layout.tsx` and the docs page canonical, so the four
can never disagree. `NEXT_PUBLIC_SITE_URL` is inlined at build time, so an unset value would
otherwise ship a production sitemap and robots.txt pointing at localhost with nothing failing
loudly; the helper throws on that condition instead. Outside production it falls back to
`http://localhost:3000`, so a local build stays self-consistent rather than broken.

**The sitemap derives every entry from `source.getPages()`**, the same choke point every other
content consumer reads. Adding a page to `content/docs/` puts it in the sitemap with no further
change. The home page at `/` is not in the doc collection and is prepended by hand.

Upstream's Docusaurus sitemap needed a `nonCanonicalRoutePatterns` ignore list because Docusaurus
routed partials, `_`-prefixed files, and auto-generated `/category/` index pages. **Here there is
nothing to exclude:** partials live in `content/partials/`, archived versions in
`content/_versions/`, and the glossary in `content/glossary/`, all outside the doc collection `dir`,
so `source.getPages()` cannot return them. Verified 2026-09-11: the sitemap's URL set is exactly the
339 unique doc URLs in `/llms.txt`, plus `/`.

`lastModified` is emitted per page only when `page.data.lastModified` exists. It comes from the
`lastModified` option on the docs collection, which is itself gated behind a full-git-history probe
(see [Last modified dates](#last-modified-dates)). In a shallow checkout every page resolves to
`undefined` and `<lastmod>` is simply absent, which is valid.

`app/robots.ts` ports upstream `static/robots.txt` and differs from it in two deliberate ways:

- **No `Disallow` lines.** Upstream disallowed `/category/` and `/hosted-pdfs/`; neither route
  exists here, and disallowing paths that 404 is noise.
- **`Content-Signal: search=yes, ai-input=yes, ai-train=no` is emitted through the rule's `other`
  field.** The directive is not RFC 9309; it is draft-romm-aipref-contentsignals
  ([contentsignals.org](https://contentsignals.org/)). Next models only the standard directives and
  documents `other` as the pass-through for exactly this, available since Next 16.3.0, so no
  separate `app/robots.txt/route.ts` handler is needed. Next emits `Allow` before `other`, which
  reorders the lines relative to upstream's file; robots.txt directives are order-independent
  within a group, so the meaning is unchanged.

Neither route is reachable by the rewrite patterns today (both are anchored at `/docs`). They are
in the bypass list by convention, because that list is where a route that must be served verbatim
is cheap to state and hard to break from a distance.

## Partial versioning

Archived pages live in `content/_versions/<id>/…` — a separate, non-routed collection, outside
`content/docs` for the same reason partials are. `lib/versions.ts` indexes them by path. Only
hand-registered pages are versioned, in the `VERSIONED` registry in `lib/versions-constants.ts`.

An archive is served at `/docs/<slug>/<id>` (FS-2698 moved it off `?v=<id>`, which made every docs
page dynamic). `lib/source.ts` `resolveDocsPath()` reads that path, **page first**: `/docs/a/b` is
only reinterpreted as archive `b` of page `a` when no page exists at `a/b`, so an archive id can
never shadow a child page. `scripts/versions-routing.test.mjs` separately asserts that no such
collision exists, so creating one is a reviewed act.

### The archive's markdown mirror

An archive answers the same three markdown shapes a live page does (FS-2711):

| Request                                          | Serves                            |
| ------------------------------------------------ | --------------------------------- |
| `/llms.mdx/docs/<slug>/<id>/content.md`          | the archive's processed markdown  |
| `/docs/<slug>/<id>.md`                           | the same, via the suffix rewrite  |
| `/docs/<slug>/<id>` with `Accept: text/markdown` | the same, via content negotiation |

**None of that is a new URL family.** Both rewrites in `proxy.ts` are written over the whole path
under `/docs`, so they already mapped an archive path onto `/llms.mdx/docs/<slug>/<id>/content.md`;
what was missing was a route handler that resolved it, which is why the three shapes 404ed rather
than serving the wrong version. The handler now shares `resolveDocsPath()` with the docs page, so
the two cannot disagree about what a path means, and its `generateStaticParams` prerenders the
three archive mirrors alongside the live ones (1060 prerendered routes, up from 1057).

One shape changed as a side effect. The handler now carries `dynamicParams = false`, so a markdown
request for a slug outside the generated set (`/docs/nope.md`, `/llms.mdx/docs/nope/content.md`, or
`Accept: text/markdown` on `/docs/nope`) is answered the way `/docs/nope` is: the 82 KB HTML
`app/not-found.tsx` body with status 404 and `no-store`, where the base sent an empty body with
`s-maxage=31536000`. A markdown client gets HTML on a miss and misses are no longer edge-cacheable;
no consumer here ever requests a miss, so it is recorded rather than worked around.

Three things this must keep getting right:

- **`postprocess.includeProcessedMarkdown` is per collection.** The `docsVersions` collection sets
  it separately from `docs`; without it `getText('processed')` rejects and the archive mirrors fail
  at request time, a long way from `source.config.ts`.
- **An archive is `noindex` with a canonical to the live page.** The HTML carries both tags. A
  markdown body can carry neither, so the mirror sends `X-Robots-Tag: noindex, follow` instead.
  Live markdown sends no such header.
- **Archives stay out of discovery.** `llms.txt`, `llms-full.txt`, the sitemap and `og/` all derive
  from `source.getPages()`, which never sees the `docsVersions` collection, so this holds by
  construction rather than by exclusion. `scripts/static-docs-http.test.mjs` asserts it against the
  built site anyway, because "by construction" is exactly the kind of claim that quietly stops
  being true.

The page's own copy and view-as-markdown controls point at whichever version is on screen. Serving
Latest's text under an archive URL is the specific mistake this closes: `/docs/<slug>.md?v=v1` did
it silently before FS-2698, and answering 404 afterwards was a deliberate stopgap rather than an
end state.

**An archive is a path, not a query parameter.** FS-2698 moved the selector from
`/docs/<slug>?v=<id>` to `/docs/<slug>/<id>`, which is what lets the docs route prerender at all
(see [static routing](#static-routing-under-docs)). `proxy.ts` 308-redirects the legacy `?v=` form,
a registered id to the path and anything else to the bare path, which renders Latest exactly as an
unknown `?v=` always did. A real page always wins: `/docs/a/b` is only read as archive `b` of page
`a` when no page exists at `a/b`.

The registry itself lives in `lib/versions-constants.ts`, which imports nothing, because `proxy.ts`
needs `isArchiveId` and cannot afford `collections/server`. `lib/versions.ts` keeps the lookups
that need the compiled archive bodies. `scripts/lib/versions-registry.mjs` text-parses the registry
rather than importing it, because no plain-node script can import `lib/source` — neither the
`collections/*` alias nor TypeScript resolves. `redirects-check.mjs` hits the same wall, which is
why it reads `/llms.txt` off a running site instead. Two scripts read that parse:
`scripts/versioned-docs-check.mjs` (the advisory) and `scripts/versions-routing.test.mjs` (the
invariants that fail).

## Glossary and inline references

`content/glossary/*.mdx` is a reference collection with its own shape — `{ id, title, sortAs? }`,
**not** the page contract. It is surfaced by `<Reference>`, `<Term>`, and `<ReferenceList>` via the
registry in `lib/references.ts`.

**It is hand-maintained here.** Until FS-2706 a script resynced it from the Docusaurus repo's
glossary partials on demand; that repo is archived and the script is gone, so a new term is written
as a new `.mdx` file in this directory and nothing else has to happen. `pnpm references:check`
proves every `<Term id>` and `<Reference>` names a real entry, which is the only gate over this
collection.

New reference types add a collection plus one registry entry.

## Custom MDX components

`components/mdx.tsx` is the registry and the source of truth — read it rather than trusting a list
here. Implementations live in `components/mdx/`. Fumadocs' `Accordion`/`Accordions` and `Tab`/`Tabs`
are re-exported.

Some names are aliases of the same component: `AEL` → `AddressExplorerLink`, `ImageWithCaption` →
`ImageZoom`. Every Docusaurus widget the content uses is now ported, so there is no placeholder
component any more.

Adding a component here makes it available in all MDX with no import.

**Heavy widgets load lazily.** Every docs page imports `components/mdx.tsx`, so a static import
there puts the component's library in every page's client bundle. A widget with a large dependency
therefore sits behind a `'use client'` wrapper that `next/dynamic`s the implementation:
`components/mdx/VendingMachine/index.tsx` is the pattern. Server rendering stays on, so the markup
is still in the HTML and only the JavaScript is deferred.

**VendingMachine.** The quickstart's "free cupcakes" demo (`components/mdx/VendingMachine/`), ported
from the Docusaurus component of the same name. `type` is a closed union: `web2` keeps balances in
tab memory, while `web3-localhost` and `web3-arb-sepolia` talk to a `VendingMachine.sol` the reader
deploys themselves, through the injected EIP-1193 wallet using viem. Reads go through a public
client and writes through a wallet client, with no chain or contract address hardcoded. Anything
outside the union falls back to the web2 widget, because MDX call sites are not type-checked and a
misspelling must not put a reader on a web2 page in front of a wallet prompt. The ABI is transcribed
into `abi.ts` as a TypeScript `as const` (the compiled artifact's bytecode was never used) so viem
can infer argument and return types. With no wallet installed the widget renders a notice instead of
throwing.

**EdgeChallengeFlow.** The BoLD bisection replay (`components/mdx/EdgeChallengeFlow/`), ported from
the Docusaurus interactive diagram. d3 draws one tree per challenge level; the reader plays, steps,
or jumps to the end of a recorded Arbitrum Sepolia challenge. The 236 KB event log stays a static
asset at `public/data/edge-challenge-flow.json` and is fetched on mount, so it never enters a
JavaScript bundle; `/data/` is on `proxy.ts`'s bypass list, by the same convention as every other
top-level route and not because a rewrite currently reaches it. Its stylesheet
(`edge-challenge-flow.css`) reads `--color-fd-*` tokens for every surface and text colour, and
declares only the four status hues (active, bisected, has-rival, OSP confirmed) itself, once per
theme, so no colour is hardcoded in the d3 code. Panel labels are `h4`/`h5`: the widget sits inside
a page section, so its labels nest under that section's heading rather than competing with it in a
screen reader's heading list. Tree nodes are focusable, with Enter/Space to inspect and the arrow
keys to expand or collapse, and wheel zoom needs a modifier key so scrolling past the diagram does
not trap the page.

That snapshot has a generator: `pnpm edge-challenge:fetch`
(`scripts/fetch-edge-challenge-data.mjs`). It reads every `EdgeAdded` / `EdgeBisected` /
`EdgeConfirmedByOneStepProof` log the BoLD `ChallengeManager` contract has emitted on Arbitrum
Sepolia, backfills the `EdgeAdded` event for any edge only ever referenced (never directly logged)
by a later event, resolves the staker address behind each `EdgeAdded` transaction, and overwrites
`public/data/edge-challenge-flow.json`. **Nothing runs it automatically** — not the build, not CI,
not `upstream-refresh.yml`. Run it by hand when the rendered flow looks out of date, review the
diff, and commit it deliberately. It has **no `--check` mode**, unlike `contracts:check` or
`cli:check`: those compare against a pinned, deterministic input, while this one's source is live
chain state, so a second run legitimately returns a superset of the first. There is no "stale" to
detect here, only "older", and a check that goes red the moment anyone opens a challenge on Sepolia
is not something to gate a build on. The script was ported from upstream `arbitrum-docs` under
FS-2702, before that repo is archived, because the decoding and backfill logic is not recoverable
from the committed JSON.

**FlowChart.** The Timeboost centralized auction diagram (`components/mdx/CentralizedAuction/`),
registered under the name the MDX already used. The artwork is a 2300-line inline SVG exported from
a design tool and keeps its own palette, because recolouring an illustration per theme is not the
same as theming a UI. On top of it sit five numbered markers; three of them open a step dialog, as
upstream had it, built on the same Radix dialog as `PdfModal` with the code sample highlighted by
Fumadocs' `DynamicCodeBlock`. The upstream `@react-spring/web` animations (a pulsing ring, a hover
grow, a dialog fade) are CSS here, so the dependency was not carried over, and all three respect
`prefers-reduced-motion`.

**Image zoom.** `<ImageZoom>` resolves to the wrapper in `components/mdx/ImageZoom/`: plain `<img>`
child, supports `caption`, needs no dimensions, no Next image optimization. To use Fumadocs' native
component instead — for `_next/image` optimization — import it per file, which shadows the wrapper
for that file. The native component then requires `width`/`height` or the build fails; add
`style={{ width: '100%', height: 'auto' }}` for responsiveness and drop `caption`.

## Remote images are never fetched at build

`source.config.ts` sets `remarkImageOptions: { external: false }`. Nothing in the build requests a
third-party image.

**Why.** Fumadocs' `remark-image` probes each image for its intrinsic size so it can emit
`width`/`height`. For an `https://` src that probe is an HTTP request made while MDX compiles, and
its `onError` default is `error`. One third-party URL that started answering 403 therefore threw
during compilation and took down **every** docs page, not only the page holding the image:
`/docs/get-started` served a 500 with `[Remark Image] Failed obtain image size for
https://imgur.com/0q5bHZK.png`. That is the failure FS-2681 removed.

**What this means per syntax.** The two ways to put an image on a page are no longer equivalent, and
the difference is the thing to remember:

| Syntax                          | Component                                    | Remote src after this change |
| ------------------------------- | -------------------------------------------- | ---------------------------- |
| `![alt](https://…)`             | `next/image`, via `defaultMdxComponents.img` | **The page 500s.**           |
| `<ImageZoom src="https://…" />` | `components/mdx/ImageZoom`, a plain `<img>`  | Renders.                     |
| `![alt](/img/…)`                | `next/image`, measured from disk             | Renders, optimized.          |

Markdown is the broken one because `next/image` requires dimensions it can no longer obtain.
Measured on a scratch page, not inferred: a reachable remote src in markdown syntax returns HTTP 500
with `Image with src "…" is missing required "width" property`, while the same URL through
`<ImageZoom>` returns 200 and emits `<img src="https://…">`. A remote markdown image would fail for
a second reason as well if it got past the first, since `next.config.mjs` declares no
`images.remotePatterns`.

**So:** commit images under `public/` and reference them as `/img/…`. That is the only form that is
both reliable and optimized. Where a third party's own CDN copy has to be used, `<ImageZoom>` is the
supported way, as `content/docs/third-party-docs/Particle/particle.mdx` does.

**Why `external: false` and not `onError: 'ignore'`.** Both stop the compile from throwing.
`external: false` also stops the compile from touching the network at all, which keeps it
deterministic and lets the `Build` job become blocking. `onError: 'ignore'` would keep a network
round trip per remote image for a `width` that markdown cannot use anyway. Local images are still
measured from disk, and `onError` stays at its default `error`, so a missing or corrupt file under
`public/` still fails the build rather than shipping a broken page.

**Finding them.** One script, two modes:

- `pnpm images:presence` is offline and **blocking in CI**. It fails when a markdown image with a
  remote src appears anywhere in content, which is exactly the case that 500s.
- `pnpm images:check` requests every remote image, markdown or JSX, and prints the ones that no
  longer answer. Report only, exits 0 unless `--strict`, and deliberately not in CI: a third party's
  outage is not a reason to fail somebody else's pull request.

## Page weight and what loads late

Lighthouse scored the three sampled pages 81, 84 and 80 against a bar of 90 (plan M-50), and the
cost was payload rather than execution: main-thread work and script bootup both scored 1 while
Largest Contentful Paint sat at 3.9 to 4.4 seconds. FS-2715 worked through that. What follows is
what moved and why, because every one of these is the kind of change someone undoes by accident.

**Measure it the same way or the numbers mean nothing.** Lighthouse 13.4.1, mobile form factor,
simulated throttling, against `next start` on localhost:

```bash
CHROME_PATH="<Chrome for Testing>" npx lighthouse@13.4.1 <origin>/<path> \
  --output=json --output-path=<file>.json \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu" \
  --only-categories=performance,accessibility,best-practices,seo
```

Take the median of at least three runs, and interleave the pages rather than running one page three
times: a loaded machine moves a single score by ten points, and a run of three that all land in the
same busy window looks like a regression. **A local server is a floor, not the number.** There is no
CDN in front of it, so every request pays a full round trip under simulated throttling, which is why
a 1.3 KB stylesheet can be charged 300 ms here and almost nothing in production.

**Three runs is not enough on `cli-flags-reference`, and the reason is in the change itself.** The
baseline is tight: across three independent sessions its scores span 74 to 81 with a median of 76.
This branch is bimodal on that page, roughly 77 to 78 in the slow state and 82 to 86 in the fast one
(one run reached 92), so a median jumps between modes from session to session (82, 81.5 and 78 in
the three sessions) and no single "+N" is honest. Quote the two modes: the win is **+2 to +10**
depending on the run. The spread is in simulated First Contentful Paint, which
the score tracks one for one on this page, because the Largest Contentful Paint element is text
painted at first paint. In one session the baseline's FCP sat at 1.66 to 1.68 s on all five runs
while ours landed at 1.97 s on four and 1.67 s on the fifth, and that fifth run is the one that
scored 92. The cause is the font change below: this page is dense with inline code, so it genuinely
needs Aeonik Fono, which is no longer preloaded and therefore starts at 127 to 146 ms discovered by
CSS instead of 62 ms discovered by a preload link. Whether Lighthouse's simulator charges that later
start to FCP varies run to run. **It is not the Inkeep chunk**, which was the first guess: that chunk
downloads at `Low` priority starting 251 to 337 ms on _both_ builds, while observed LCP equals
observed FCP at 119 to 185 ms on both, so it is outside the paint window either way. Take nine runs
on this page, not three, and do not read a single preview run on it as evidence of anything.

**The Inkeep chat widget is loaded on idle, after `load`.** `@inkeep/cxkit-react` is by a wide margin
the heaviest thing this site ships: its built chunk is 1.19 MB on disk (the package directory itself
is only 200 KB, so measure the chunk, not `node_modules`), about 321 KiB transferred, of which Lighthouse
measured 190 KiB as unused on a page where nobody has asked a question. It used to be requested
during hydration on every page, putting a third of a megabyte in direct contention with LCP for a
floating button that is worth nothing until it is clicked. `components/inkeep/inkeep-chat-button.tsx`
now waits for the `load` event and then a `requestIdleCallback` before rendering it. **Both halves
matter**: gating on idle alone was not enough, because hydration finishes early and the main thread
goes quiet while images and fonts are still in flight, so the callback fired around 300 ms, back
inside the window it was meant to avoid. This is not the search path. Cmd-K search goes through
`components/inkeep/inkeep-search.tsx`, whose own dynamic import fires when Fumadocs opens the dialog
and is untouched.

**Only the two upright body faces are preloaded.** The root layout declared five `next/font`
families and every one of them preloaded on every route, which is 230 KiB of high-priority requests
racing the LCP element. Three are now `preload: false`: Aeonik Fono (inline code), JetBrains Mono
(fenced blocks) and FK Screamer (the home hero heading, and nothing at all on the other 349 pages).
The 349 pages that never use them stop paying entirely. **A page that does use one pays a little
more, so this is a trade and not a free win.** On `cli-flags-reference`, which is dense with inline
code, Aeonik Fono is now discovered by the CSS rather than by a preload link, so it starts at 127 to
146 ms instead of 62 ms, at `VeryHigh` rather than `High`. Simulated FCP on that page moved from
1.66 to 1.68 s on the baseline to about 1.97 s on four of five runs here. LCP still improves by
roughly a second, so the page is a clear net win, but "no slower" would be wrong.

**The italic face is its own `next/font` declaration.** `preload` is per declaration in `next/font`,
not per `src` entry, so while Aeonik Italic sat beside the two uprights it was preloaded wherever
they were. At 48 KiB it was the single largest preload on the site and the first request after the
HTML, to serve the handful of `<em>` runs a page contains. It is now `sansItalic` with
`preload: false`, and `app/global.css` points `em, i, cite, dfn, var, address, .italic` at
`--font-sans-italic`. **That CSS rule is what re-attaches the face**: `--font-sans` no longer carries
an italic `src`, so without it `font-style: italic` plus `font-synthesis: none` renders `<em>`
upright. Delete one and you must delete the other.

**A component's own stylesheet is render-blocking if a server module can reach it.**
`components/mdx.tsx` is a server module, so Next cannot code-split anything it imports (the same
wall the comment in `components/mdx/Twoslash.tsx` describes). Every client component reachable from
that registry therefore contributes its CSS to the critical path of all 349 docs pages, whether or
not the page renders the component. Two did: `components/HoverPopover/styles.css` (glossary
popovers) and `components/mdx/reference-list.css` (two rules, for the one page that renders
`<ReferenceList>`). Both moved into `app/global.css`, which the page already blocks on.

**Folding one of them was not enough, and that is the part worth remembering.** Turbopack groups
these imports into a shared chunk, so with `reference-list.css` still importing, the chunk simply
got smaller and `/docs/stylus` still blocked on four stylesheets. Folding the second one deleted the
chunk: the CSS _modules_ left behind (`VanillaAdmonition`, `ImageZoom`, `PdfModal`) merged into the
chunk that already carried the image-zoom vendor CSS, and the page went to **three**. Total CSS
bytes are the same either way, near enough to the byte; what goes is one round trip, which is what
costs on this critical path. The modules cannot be folded the same way, because their class names
are hashed at build.

**Adding a plain `.css` import to a component in that registry adds a render-blocking request to
every docs page.** Measured, not inferred: adding a single 46-byte stylesheet to `ReferenceList`
splits the module chunk back out and takes `/docs/stylus` from three stylesheets to four. Put the
rules in `app/global.css` instead, or put the component behind a `next/dynamic` boundary the way
`VendingMachine`, `EdgeChallengeFlow`, `CentralizedAuction` and `Twoslash` already are. Check with
`curl -s <origin>/docs/stylus | grep -o '<link rel="stylesheet"' | wc -l`, which should read 3.
Every stylesheet link sits on the document's first line, so `grep -c` counts that line once whatever
the number is.

**`lucide-react` is pinned to the version `fumadocs-ui` resolves.** `package.json` asked for
`^1.33.0` while `fumadocs-ui` requires `^1.43.0`, so pnpm installed both and both shipped to the
browser. The direct dependency is now `^1.45.0`, which lets `fumadocs-core`'s `*` peer and
`fumadocs-ui`'s range collapse onto one copy. Check with `pnpm why lucide-react` after any Fumadocs
bump; a second copy reappearing is silent.

**The home hero image carries all three priority hints.** It is the home page's LCP element
(measured). Next 16 deprecated `priority` in favour of `preload`, and `preload` on its own emits the
`<link>` with no priority hint, which is exactly what Lighthouse's LCP discovery check was failing
on: discoverable early, but queued behind everything else. `components/home-hero.tsx` now passes
`preload`, `fetchPriority="high"` and `loading="eager"` together. **That is a deliberate deviation
from Next's own advice**, which lists `loading` and `fetchPriority` under "when not to use"
`preload` and says to pick one
(`node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md`). Picking one leaves
the audit failing, and the combination raises nothing: `get-img-props.js` throws only for `preload`
with `loading="lazy"` or with the deprecated `priority`. Do not "fix" it back to the documented
shape without re-running the LCP discovery audit.

**What is left, and was deliberately not done.** The largest remaining render-blocking cost is
`katex/dist/katex.css`, imported in `app/layout.tsx`: 29 KB raw, 5.7 KiB transferred, blocking on all
350 routes, and **exactly three pages render any KaTeX markup**. Splitting it would mean deciding per
page whether a page contains math, and the only signal available before render is a regex over the
raw markdown, which over-matches every `$` in a shell command and, worse, fails quietly the other
way: a page whose math the regex misses renders raw KaTeX markup with no styling. That is a bad
trade for a saving Lighthouse charges at ~162 ms largely because localhost pays a full round trip per
request. Revisit it against a Vercel preview, where the real number will be much smaller. Two other
items are outside this repo: about 13 KiB of legacy JavaScript inside Next's own framework chunk
(worth ~150 ms of LCP, nothing here controls it), and the `?_rsc=` route prefetches Next issues for
in-viewport links, which are 60 to 106 KiB per page and are the price of instant navigation.

## The Node runtime

**Node 22 LTS, everywhere.** Three files state it and they must agree:

| Where                            | What it says       | Who reads it                                    |
| -------------------------------- | ------------------ | ----------------------------------------------- |
| `engines.node` in `package.json` | `>=22.0.0 <23.0.0` | pnpm, which refuses to install on another major |
| `.node-version`                  | `22`               | Vercel, nvm, fnm, asdf                          |
| Vercel project settings          | Node.js 22.x       | the build and the serverless functions          |

`.node-version` is the one that makes a fresh machine and a fresh Vercel build agree without anyone
remembering to configure it. Vercel reads it on every build and pins the runtime to that major;
without it Vercel uses its own current default, which is ahead of `engines` and drifts again each
time Vercel moves.

**The Vercel project setting still has to be set to Node.js 22.x by hand** (Settings, then Build and
Deployment, then Node.js Version). `.node-version` pins the build; the project setting is what the
deployed functions run on, and a mismatch between them is not reported anywhere.

**Locally, use nvm**: `nvm use 22` in this directory, or `nvm install 22` first. nvm reads
`.node-version` as well as `.nvmrc`, so no argument is needed once the file is present. Node 24 and
26 are rejected by `engines` before anything installs, which is the intended behaviour and not a bug
to work around with `--ignore-engines`.

## Analytics

Four independent paths send events to the same PostHog project. They share nothing but the
project token, so one being off does not affect the others.

| Path                                   | Where                                               | Runs on                                           |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| Page feedback                          | `lib/posthog.ts`, a server action                   | everywhere, including local                       |
| Web analytics (`$pageview`)            | `components/analytics/posthog-provider.tsx`, client | production only                                   |
| Inkeep search and chat (`inkeep_*`)    | the bridge in `lib/inkeep.ts`, client               | production only, piggybacking on the client above |
| Markdown fetches (`llms_file_fetched`) | `proxy.ts` via `lib/llms-tracking.ts`, server       | production only                                   |

The fourth path is documented in full under [Request tracking](#request-tracking); the rest of this
section is about the three client and server-action paths.

**The production gate.** `VERCEL_ENV` is a server-only variable, so a client component cannot read
it. Vercel exposes the same value to the browser as `NEXT_PUBLIC_VERCEL_ENV`, which is what the
provider checks. Request tracking runs in the proxy and so reads the server-side `VERCEL_ENV`
directly; the two gates are the same value reached from different sides. It is `production` on the
production deployment, `preview` on every preview build, and unset locally.

That check has to stay written as a literal `process.env.NEXT_PUBLIC_VERCEL_ENV` member expression.
Next inlines those at build time, so on a non-production build the enabled flag folds to `false`
and the guarded `import('posthog-js')` is dead code. Destructuring `process.env` into a local first
turns it into a runtime lookup and loses that.

The SDK sits behind `import()`, so it compiles to its own async chunk (~290 kB) rather than joining
the chunk the layout loads. Turbopack emits that chunk either way, but with the gate off the
browser never requests it: no script fetch, no `init`, no events, and `window.posthog` stays
undefined.

**Pageviews are manual.** `capture_pageview` is `false` because the App Router never does a full
page load on navigation. `PageviewTracker` captures `$pageview` from an effect keyed on
`usePathname()` and `useSearchParams()`. `useSearchParams` forces client-side rendering up to the
nearest Suspense boundary, so the tracker is wrapped in its own `<Suspense>` and the rest of the
tree still prerenders.

**The `window.posthog` contract.** `lib/inkeep.ts` predates this component and looks for a global
with a `capture` method; it no-oped for as long as nothing set one. The provider assigns the
initialised client to `window.posthog` after `init()`, which is the only reason the `inkeep_*`
events start flowing. Anything that replaces the provider has to keep that assignment.

**Capture settings** mirror the Docusaurus `posthog-docusaurus` config: `persistence: 'memory'` (no
cookies, no localStorage), session replay off, autocapture off, and the remote-config request
disabled. `defaults` is pinned to a dated value so upgrading `posthog-js` cannot silently change
what is captured.

**The 404 page** (`app/not-found.tsx`) captures `404_error` through
`components/analytics/not-found-tracker.tsx`, with the same fields the Docusaurus `NotFound`
swizzle sent: pathname, search, hash, referrer, user agent, and full URL. It reads `window.posthog`
rather than importing the SDK, so it captures nothing outside production instead of pulling a few
hundred kilobytes into every deployment. Because the SDK initialises from an effect of its own, out
of a ~290 kB async chunk, and no ordering between the two effects is guaranteed, the tracker retries
on a backoff spanning about sixteen seconds rather than losing the event to that race. It snapshots
the location at mount, so a late attempt still reports the URL the reader landed on. These events are what M-53 monitors after cutover to find inbound URLs the
redirect map still misses.

**Environment variables.** `NEXT_PUBLIC_POSTHOG_KEY` is the PostHog project token (`phc_…`), which
is write-only and safe to expose. `NEXT_PUBLIC_VERCEL_ENV` is set by Vercel; you never set it by
hand. Setting the key locally does nothing on its own, which is deliberate: local browsing must not
pollute production data.

## The gates

CI runs on push and PR to `main` (`.github/workflows/ci.yml`) in three jobs. **Only the first
blocks.**

**`Gates` (blocking)** — thirteen steps:

| Step                       | Catches                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `types:check`              | Frontmatter schema violations, TypeScript errors                              |
| `test`                     | Regressions in the tooling scripts themselves                                 |
| `vars:check`               | A `<Var name>` with no matching key in `vars.json`                            |
| `nav:check`                | `meta.json` navigation integrity, including sidebar root coverage             |
| `partials:check`           | Unresolved includes, routing leaks, stale catalog, `cwd` include in a partial |
| `versioned-docs-check.mjs` | Archived-page registry drift                                                  |
| `references:check`         | Glossary ids and `<Reference>` targets                                        |
| `faq:check`                | A `faqsId` with no matching entry in the FAQ data                             |
| `images:presence`          | A markdown image with a remote src, which renders as a 500                    |
| `check-links`              | Broken internal doc links and MDX fragments                                   |
| `contracts:check`          | The generated contract-address partial matches `@arbitrum/sdk`                |
| `format:check`             | Prettier style drift                                                          |
| `content:lint`             | MDX structural defects, rules A1 through A11 except A7                        |

`check-links` exists because Fumadocs has no equivalent of Docusaurus's `onBrokenLinks: 'throw'`.
`pnpm build` chains it ahead of `next build`, so a broken link or fragment also fails the Vercel deploy.

Fragment validation compiles each routed document with `@mdx-js/mdx`, Fumadocs' `applyMdxPreset`
and `remarkInclude`, and the same options the site imports from `lib/mdx-options.mjs`. It reads
IDs from the resulting HTML syntax tree instead of approximating heading slugs. Nested and repeated
includes retain their position in the document, so duplicate headings and `[#custom-id]` headings
resolve as they do on the site. Markdown and literal JSX links in included partials are checked in
each containing page's URL context; errors name the partial's original file and line. The checker
drops one preset plugin, `rehypeCode`: syntax highlighting never produces an id, and shiki plus
the twoslash transformer were two thirds of the run (15.5 s against 5.1 s on 348 pages, identical
findings). Everything else, remark plugins and `rehypeKatex` included, runs exactly as on the site.

Same-page, relative, and root-relative fragments are checked, including percent-encoded IDs and
query strings. External URLs, public-asset fragments, and dynamic JSX expressions are outside this
check. It does not execute React components: anchors generated only at component runtime still need
browser verification, as do scrolling and heading visibility. `--json` retains its reporting-only
exit status of 0 for link findings; MDX compilation errors exit 1 in either mode. The default command
blocks on both broken paths and missing fragments, through the existing CI gate and build command.

`format:check` and `content:lint` are the two newest entries, promoted on 2026-09-15. Until then
they sat in a third, non-blocking `Content debt` tier, which existed to hold a check whose count
was not yet zero: `format:check` opened at 49 unformatted files and `content:lint` at 181
findings, and blocking on either would have rejected every PR over defects the migration
inherited rather than introduced. Both reached zero, so the tier had done its job and was retired.
No promote-when-zero rule is left to apply, and a failure in either step now means the PR under
review introduced it.

**`Network checks` (non-blocking)** — `precompiles:check`, marked `continue-on-error`. Reaching
zero is not what would promote this one: it is already green. It fetches about thirty Solidity
sources from `raw.githubusercontent` on every run, so a GitHub blip turns it red for reasons
unrelated to the change under review, the same argument that keeps `Build` non-blocking. Its
sibling `contracts:check` reads a registry that ships inside `@arbitrum/sdk` at an exact pin, so
it is offline and blocks. Losing the network dependency is what would promote
`precompiles:check`.

**`Build` (non-blocking)** runs `pnpm build`. It catches MDX compile errors that `types:check` cannot
see. It was made non-blocking because the MDX image pipeline fetched remote images at build time, so
a dead third-party URL turned it red for reasons unrelated to the change under review. That reason
is gone: the build no longer touches the network for images (see
[Remote images are never fetched at build](#remote-images-are-never-fetched-at-build)). Promoting
this job into `Gates` is now possible and wants its own change, not least because a full build is
the slowest job here.

**Run by hand only:** `cli:check`, `stylus:check`, and the network mode of `images:check`.
`images:check` reaches out to third-party hosts, so its result depends on somebody else's uptime;
its offline sibling `images:presence` does run in CI. `redirects:check` is no
longer hand-only for a PR either — it runs as the last step of the `Build` job, against `next start`
on localhost (see [Redirects](#redirects)). It is not in the blocking `Gates` job because it needs a
running site, and the only cheap way to get one is to reuse the build that `Build` already does;
promoting `Build` promotes it too. It is still available by hand with `--base-url`, against a local
`pnpm dev` or any other URL.

`upstream-refresh.yml` runs Mondays at 08:00 UTC and on `workflow_dispatch`, in two independent
jobs. **"Upstream" in its name means the pinned Nitro release, go-ethereum, the `@arbitrum/sdk`
network registry and `offchainlabs/stylus-by-example`.** It has not meant the Docusaurus repo since
FS-2706 deleted the third job, `drift`, which compared the two content trees and maintained an
"Upstream drift" issue from the result.

- **`refresh`** runs `nitro:check-release`, then `precompiles:generate`, `contracts:generate` and
  `cli:generate`, opening `automated/upstream-refresh` as a PR if anything changed. It never writes
  to `main` and no-ops when the tree is clean.
- **`stylus`** regenerates `content/docs/stylus/stylus-by-example/`, runs `ci.yml`'s whole `Gates`
  list against the result, and only then opens `automated/stylus-by-example` as its own PR.

The two jobs have no `needs` between them on purpose, so a failing generator never hides the other
job's result.

`nitro:check-release` also derives `goEthereumCommit` from the `go-ethereum` submodule at
`nitroVersionTag`, including when the Nitro tag is unchanged but the submodule pin needs repair.
Source links use `{var:goEthereumCommit}` rather than an upstream Geth tag, which may lack
Arbitrum-specific files. Avoid fixed line anchors on these links: line numbers move as the pin
updates. The release script resolves the submodule and node image before writing any changes.

The three generators' `--check` modes sit in three different places, because they are not the same
kind of check.

`contracts:check` blocks. Its input does not move on its own: the generator reads the network
registry that ships inside `@arbitrum/sdk`, and that pin is exact, so the step can only go red on
a human act. There are two, and both should block. One is a hand edit to the generated partial,
against the do-not-edit marker inside it; before this gate existed such an edit passed CI, merged,
and was then silently reverted by the next weekly refresh under the automation's authorship rather
than its author's. The other is a PR bumping the SDK to a release that moves a published address,
which is a value a reader pastes into a transaction and must never change unreviewed.

A Dependabot bump of the SDK therefore reddens only the bumping PR, not every open one: CI installs
from each branch's own lockfile, so no other branch sees the new registry until that PR merges. The
fix in that PR is one command, `pnpm contracts:generate`, and a commit of the regenerated partial.
Note the gate fires only when a bump actually moves an address; a release that changes nothing the
partial renders stays green.

`precompiles:check` does not block, for the network reason given above rather than for any
statement about its input.

`cli:check` runs nowhere automatically, and blocking on it would be a category error: its input is
a moving upstream, the Nitro tag pinned in `content/vars.json` and whatever that tag's Go source
says, so a red gate would mean "someone published a Nitro release", not "this PR is wrong". The
weekly refresh PR is where that gets noticed instead.

`stylus:check` is out of CI for the same reason, more sharply: it clones a third-party repository's
default branch with no pin at all, so a red gate would mean "someone edited stylus-by-example". The
`stylus` job in the weekly refresh does it instead, and because the PR that job opens receives no
CI of its own, that job also runs every gate on this list against the tree it is about to propose.
See [Stylus by Example](#stylus-by-example).

When `contracts:check`, `cli:check` or `stylus:check` fails it prints a line-level diff, so a reviewer can see
whether a value moved or only the formatting did. That diff is a real one, computed over a longest common
subsequence in `scripts/lib/line-diff.mjs`: comparing the two files by line index instead reported
every line after an insertion as changed, which on this 112-line partial meant 53 lines for a
two-line edit and defeated the point of printing it.

### Generated pages

Four things in `content/` are written by a generator and must never be hand-edited: the precompile
tables, the contract-address partial (both under `content/partials/`, see
[Partials](#partials)), `content/docs/run-a-node/nitro/cli-flags-reference.mdx`, and the nineteen
pages under `content/docs/stylus/stylus-by-example/`.

The CLI flags page is the only _partly_ generated file under `content/docs/`, so it is the only one
with frontmatter a writer owns. `pnpm cli:generate` replaces only the region between
`{/* GENERATED:START */}` and `{/* GENERATED:END */}`; the frontmatter and any prose outside those
markers survive untouched.

**It reads Nitro's Go source, not `nitro --help`.** The flag list is really the output of
`--help`, but producing it means building Nitro, which means a Go toolchain and the Rust arbitrator
artifacts in a workflow that otherwise installs nothing but Node. So the generator parses the
`…ConfigAddOptions` functions instead, composing each dotted name from the prefix its caller passes
and following every default back to the `var …Default = T{…}` literal it points at. Two consequences
worth knowing:

- **go-ethereum is not optional.** Nitro registers the whole `execution.rpc.*` namespace by calling
  into the submodule's `arbitrum` package, so the generator materialises that submodule at its
  pinned commit and fails loudly if it is missing, rather than dropping 19 flags silently.
- **Anything it cannot evaluate fails the run.** Five flags default to `util.GoMaxProcs()`, decided
  at process start, and three are registered with `f.Var` and a custom `pflag.Value`. Those are
  declared in `scripts/data/nitro-cli-reference.data.mjs`; a new one with no entry stops the
  generator instead of publishing a blank cell. **The check runs in both directions**: an entry in
  either list that matches no flag Nitro still registers also stops the run, so a curated
  exemption cannot rot into a no-op the way it could when both lists were plain lookups.

`--nitro-path <dir>` (or `NITRO_REPO_PATH` in the environment, which the flag overrides) reads an
existing Nitro clone. It still extracts the tree at the pinned tag, so a local run and a CI run see
the same source no matter what the checkout has checked out. `--verbose` additionally names every
flag the exclusion rules dropped, grouped by the rule that dropped it; without it the run prints
only the per-rule counts. One rule matches on the flag's **description**, so a Nitro release that
reworks a docstring can drop a flag off the page, and the counts are what make that visible in the
weekly refresh PR's log.

### Stylus by Example

`content/docs/stylus/stylus-by-example/` is nineteen pages republished from
[`offchainlabs/stylus-by-example`](https://github.com/offchainlabs/stylus-by-example), a live
third-party repository. `pnpm stylus:generate` clones it and rewrites every page; `pnpm
stylus:check` fails with a line diff when the committed tree has drifted from it. Unlike the CLI
flags page these are generated whole, frontmatter included, so there is nothing on them a writer
owns — a fix belongs upstream, or in `scripts/data/stylus-examples.data.mjs`.

They arrived here as a hand port of an arbitrum-docs pipeline
(`scripts/sync-stylus-content.js` plus a `stylus-content` job in `update-external-content.yml`),
which did not survive that repo being archived. Without the port, an edit in stylus-by-example would
have reached this site through nobody and nothing, and nobody would have been told.

Six things about it are worth knowing:

- **Nothing is pinned.** stylus-by-example publishes no releases and this site has always tracked
  its default branch, so the generator clones that. A pin would only be a second version number to
  forget to bump. The cost is that `stylus:check` depends on the network _and_ on somebody else's
  default branch, which is why **it is deliberately not a CI gate**: it would redden every open PR
  the moment an unrelated repository edited a page. The `stylus` job in
  [`upstream-refresh.yml`](.github/workflows/upstream-refresh.yml) runs it weekly instead, where a
  change becomes a PR on `automated/stylus-by-example`. That is its own job on its own branch, not
  another step in `refresh`: a failure here must not hide a Nitro pin bump, and nineteen pages of
  changed prose in the same PR as a regenerated address table is a PR nobody reviews.
- **That job runs the blocking gates itself**, between the generator and the pull request, and
  that is not belt-and-braces. A pull request opened with `GITHUB_TOKEN` triggers no workflow
  runs — GitHub's own rule, so a workflow cannot recurse — and `ci.yml` fires only on
  push/pull_request against `main`, so **nothing checks the PR this job opens**; its checks tab
  arrives empty, which reads as green. The payload is prose and frontmatter from a repository this
  project neither controls nor pins, which makes it the automated PR most in need of checking, so
  the job runs `ci.yml`'s `Gates` list step for step against the regenerated tree and fails the
  weekly run rather than shipping a PR nothing has verified. **Keep the two lists in sync**: a
  gate added to `ci.yml` and not there is a gate that PR does not get. The alternative, a PAT or
  GitHub App token on `create-pull-request` so `ci.yml` runs for real, needs a secret nobody has
  provisioned. The sibling `refresh` job has the same no-CI shape and no gates of its own; its
  payload is generator output over pinned inputs, so the exposure is smaller, but it is the same
  gap and worth closing separately.
- **The published set is an allowlist**, in `scripts/data/stylus-examples.data.mjs`, and that list
  doubles as the `meta.json` order. That order is **upstream's teaching sequence, not
  alphabetical**: `hello_world`, then the primitives, then what builds on them, straight from the
  `allowLists` block of arbitrum-docs `scripts/sync-stylus-content.js`. The hand port alphabetized
  it, which opened a beginner's section on "ABI Decode" and pushed "Hello World" to tenth; the
  parity this pipeline exists for is the reason it is back. Reordering that array is a rendered
  change to the sidebar, not a tidy-up. The order of the two sections comes from the same place,
  `basic_examples` before `applications`, and the parent
  `content/docs/stylus/stylus-by-example/meta.json` is **hand-owned, not generated**, so it has to
  be kept in step by hand. Upstream publishes sixteen more examples than these. Every run **names
  the ones it skipped**, because that log line is the only notice anyone gets that a new example
  exists; adding one is a deliberate act, since it is a new page on this site.
- **A relative link resolves against the section that publishes the slug**, and a slug this site
  does not publish stops the run. Upstream's version of that rule hardcodes `basic_examples`, which
  is only ever right because the one relative link in the published set happens to live there.
- **The `metadata` export is parsed, never evaluated.** Upstream's `title` and `description` live
  in a JavaScript object literal, not JSON, so `parseObjectLiteral` in
  `scripts/lib/stylus-examples.mjs` reads a grammar of JSON plus the four things upstream actually
  writes — single quotes, bare keys, trailing commas, a value wrapped onto the next line — and
  throws on every other token, with no fallback. It replaced a `new Function(…)()`, which is a
  different thing from cloning: a clone copies bytes, evaluating one runs it, unpinned, weekly, in
  a job holding `contents: write`, and on any maintainer's machine that runs `pnpm
stylus:generate`.
- **`meta.json` is written without Prettier** (`format: false` on `writeOrCheck`).
  `.prettierignore` excludes `**/meta.json` because `stringifyMeta` writes one array entry per line
  and Prettier collapses a short array; formatting it here would make this generator and `pnpm
move-doc` undo each other on every run.

Regenerating in September 2026 restored two things a human had changed on a generated page after
the last sync: eleven blank lines inside Rust snippets, squeezed during the Fumadocs port, and the
word "seamlessly" in the opening line of `primitive_data_types`, dropped in arbitrum-docs
`2665b2643`. Both were edits to a file that carried a `DONT-EDIT-THIS-FOLDER` marker. **An
editorial fix to one of these pages has to be made upstream** or it will not survive the next
Monday.

## The content-lint rules

`pnpm content:lint` (`scripts/content-lint.mjs`, rules in `scripts/lib/content-lint.mjs`) is the
gate for MDX that compiles and type-checks but renders wrong. Every rule but `A6` ignores fenced
blocks and inline code spans, so a page that documents syntax is never mistaken for a page that uses
it. `A6` is the deliberate exception and reads inside them, because a `<Var>` that ships as a
literal tag is exactly the defect it looks for.

| Rule  | What it catches                                                               |
| ----- | ----------------------------------------------------------------------------- |
| `A1`  | `VanillaAdmonition` with an empty body, prose stranded in `title=`            |
| `A2`  | `VanillaAdmonition` `type` outside `note\|tip\|info\|warning\|danger`         |
| `A3`  | An unconverted Docusaurus `:::` directive                                     |
| `A4`  | Markdown syntax inside a `title=` attribute, which renders literally          |
| `A5`  | An internal link target that keeps its `.md`/`.mdx` suffix                    |
| `A6`  | `<Var>` inside code, which ships as the literal tag                           |
| `A7`  | A local image `src` with no file under `public/` (**not** in the default set) |
| `A8`  | A link inside a heading                                                       |
| `A9`  | A hand-written `<p>` around block content                                     |
| `A10` | A `<tr>` that is a direct child of `<table>`                                  |
| `A11` | `<Var>` in a link destination, which never substitutes and never parses       |

`A5` judges a destination **after** `{var:name}` expansion, the way `check-links` does (FS-2733). A
destination opening with a placeholder that holds an absolute URL reads as a relative path as
written and is external once expanded, so judging the written string would flag a `.md` suffix that
is correct: the target is a file in a git repository, not a route on this site.

`A7` is the one rule the bare command does not run. It has three findings left, all on
`content/docs/stylus/cli-tools/verify-contracts.mdx`, tracked as FS-2709; the command prints a note
saying so. Run `--rule=A7` or `--all` to see them, and fold `A7` back into the default set once that
page is fixed.

### A8, A9 and A10 are one family: invalid nesting breaks hydration

These three catch HTML the browser's parser has to restructure before it can build a tree. React
then hydrates a client tree that does not match the server tree, throws
[error #418](https://react.dev/errors/418), and discards and re-renders the affected subtree. The
reader sees a flash and loses any client state in it.

**Nothing else sees this.** The page still compiles, still returns HTTP 200, and still passes
`types:check`, `check-links` and every other gate. The production readiness audit found eighteen of
350 routes failing this way (FS-2714), and the rules above were written from those three shapes:

- **`A8`, a link inside a heading.** Fumadocs wraps every heading's content in its own
  `<a href="#slug">`, so a heading that already contains a link renders `<a><a>…</a></a>`, which no
  HTML parser can represent. A markdown link, a reference link, a bare URL or angle autolink (GFM
  anchors both) and a raw `<a>` all count. A markdown **image** does not: `<img>` nests inside an
  anchor legally, and neither does `[#custom-id]`, which is how a heading pins its slug. The fix is
  to keep the heading as plain text and move the link into the prose under it, which also leaves the
  heading's slug untouched. Where a slug is load-bearing and the heading has to change anyway,
  `## Heading text [#old-slug]` keeps the old anchor. One shape stays out of reach: a shortcut
  reference link (`[ref]` alone) is indistinguishable from `[#custom-id]` without resolving link
  definitions. The tree holds one link definition today, an image reference in
  `third-party-docs/Circle/usdc-paymaster-quickstart.mdx`, used in body prose and never in a heading.
- **`A9`, a hand-written `<p>` around block content.** MDX parses a JSX element's children as flow
  content when they start on their own line, so remark wraps the prose in a paragraph and the
  element becomes `<p><p>…</p></p>`. Written inline, `<p>text</p>` renders one paragraph and is not
  flagged; the generated precompile partials use that form, and a rule that flagged it would demand
  an edit to a generated file (`generate-precompile-tables.mjs` writes them from fetched Solidity
  sources) for markup that renders correctly.
- **`A10`, a `<tr>` directly inside a `<table>`.** The parser inserts the `<tbody>` the source
  omitted, so the client tree gains an element the server tree does not have. Put every row inside a
  `<thead>`, `<tbody>` or `<tfoot>`. A raw table is still the right choice when it needs the
  `small-table` class, which `app/global.css` styles and a markdown table cannot carry.

They are three ids rather than one because the report groups by id and each shape has its own fix. A
single "invalid nesting" id would print one count covering three unrelated edits.

## The local pre-commit hook

A Husky pre-commit hook (`.husky/pre-commit`) runs `pnpm exec lint-staged` on every `git commit`,
configured in `.lintstagedrc.mjs`. It exists to catch what the gates above only catch several
commits later, in CI. It is a separate, third tier from the two CI tiers, not a copy of either
one:

- Prettier runs on every staged file type it understands, except `meta.json`. `meta.json` is
  generator output (`stringifyMeta` in `scripts/lib/doc-links.mjs`), written one array entry per
  line on purpose; Prettier collapses a short array onto one line, so the two would fight each
  other on every `pnpm move-doc` run. `.prettierignore` excludes `**/meta.json` repo-wide for the
  same reason, so `format:check` does not report them either and nothing is hidden here.
- Staged `content/**/*.mdx` files get `content:lint`, restricted to the staged files but running
  the full rule set. It was limited to `A1,A3,A4` while `A2` and `A5` still had pre-existing
  findings, because a hook enforcing a rule CI itself did not enforce would reject a commit over a
  defect the contributor did not introduce, with `--no-verify` as the only way out. Both reached
  zero on 2026-09-15 and `content:lint` became blocking in CI, so the filter came off and the hook
  and the gate now agree. If a rule added later lands with pre-existing findings, name the clean
  rules explicitly again until it reaches zero.
- Prettier and content-lint run as one sequential array entry for `content/**/*.mdx`, not as two
  separate glob entries. lint-staged runs separate glob entries concurrently by default, and an
  `.mdx` file under `content/` would otherwise match both the general Prettier glob and the
  content-lint glob at the same time, letting one read a file the other is still rewriting.
- A staged `.ts`/`.tsx` file runs one full `pnpm types:check`, not a bare `tsc --noEmit`. Next's
  route-handler types and the fumadocs-mdx `.source/` collection are both generated, so plain
  `tsc` fails on a fresh checkout with no `.next/types` yet; `types:check` regenerates both first.
  This also means the hook cost is not proportional to the edit: even a one-line `.ts` change pays
  for a full regenerate-and-typecheck pass.

The hook skips entirely when `CI=true` (CI already runs the full `Gates` job) and when `HUSKY=0`.

## What nothing catches

Every gate has a blind spot. These are the ones that have bitten:

- **Runtime-generated anchors and obscured headings.** `check-links` validates compiled MDX IDs,
  but does not execute React components or measure the viewport. Click changed anchors in a browser
  and confirm the target is visible below sticky navigation.
- **Client components importing `lib/source`.** Costs megabytes in the browser bundle. No gate sees
  it.
- **Rendering.** `types:check` proves the schema, not the render. It exits 0 on pages that serve
  literal `:::`, `undefined`, or HTTP 500. Confirm content changes in a browser.
- **A redirect to the wrong-but-existing page.** `redirects:check` only proves the destination
  resolves.
- **A page deleted without a redirect.** `check-links` validates the links that exist, so deleting
  a page along with its inbound links passes every gate while the page's published URL starts
  404ing. `move-doc` covers a move, and `redirects:check` proves a destination resolves, but
  neither sees a plain deletion, and the upstream comparison that would have reported the page
  absent after the fact went with FS-2706. Write the redirect into `redirects.config.mjs` by hand
  in the same commit as the deletion.
- **A third-party image that has rotted.** Nothing in CI requests it, so a dead URL behind
  `<ImageZoom src="https://…">` is silent. `pnpm images:check` is the manual sweep. The one case CI
  does catch is a remote image in markdown syntax, via the offline `images:presence` gate.

**Browse on `localhost:3000`, not `127.0.0.1`.** On `127.0.0.1` React does not hydrate and every
component looks broken.

## Static routing under `/docs`

Every live docs page and every archived version is prerendered at build, and a slug that is in
neither list returns 404 without the page ever rendering. Two exports in
`app/docs/[[...slug]]/page.tsx` do that, and each one closes a different ticket:

- **`generateStaticParams()`** returns `source.generateParams()` plus `archiveParams()`, so the
  build enumerates all 349 live pages and all three archived versions (FS-2698). This became
  possible only when `?v=` moved off `searchParams` and onto a path segment in the same change: a
  page that awaits `searchParams` is dynamic by definition, and a dynamic route prerenders nothing
  whatever `generateStaticParams` returns.
- **`dynamicParams = false`** makes Next answer 404 for every slug outside that generated set,
  without rendering the page (FS-2688).

Measured on Next 16.3.4 (2026-09-17) with a full `pnpm build`, counting
`.next/prerender-manifest.json` rather than reading the route table:

| Prerendered routes    | Count |
| --------------------- | ----- |
| `/docs/**` pages      | 352   |
| `/og/docs/**` images  | 349   |
| `/llms.mdx/docs/**`   | 352   |
| Static routes and `/` | 8     |
| Total                 | 1061  |

The 352 is 349 live pages plus the three archives, and the markdown mirrors match it one for one
since FS-2711. The eight are `/`, `/_not-found`, `/_global-error`, `/llms.txt`, `/llms-full.txt`,
`/robots.txt`, `/sitemap.xml` and `/opengraph-image-<hash>`, the home page's social card
(FS-2713).

### The `/docs/*` 404 is a real page (FS-2688)

**`dynamicParams = false` is what gives an unknown `/docs` URL a visible body.** The slug is absent
from the generated param set, so Next answers 404 before rendering starts: the request lands on
Next's internal `/_not-found` entry and `app/not-found.tsx` is served as an ordinary prerendered
page, with the status set before any render happens.

What that replaced was not a styling problem. `notFound()` thrown from a **dynamically** rendered
page, outside a Suspense boundary, aborts the flight render, and Next discards the response in
favour of its hardcoded `<html id="__next_error__">` shell, which carries no visible body until
hydration. The status was 404 and the `noindex` was correct throughout, so nothing in CI or in a
header check ever noticed. The page was simply blank to crawlers and to any client without
JavaScript, and nearly every inbound 404 after cutover is expected to land under `/docs/`.

Verified by building and serving the production output:

```bash
pnpm build
# `pnpm start --port 3000` works too; only an explicit `pnpm start -- --port 3000` fails, with
# "Invalid project directory provided". CI reaches for `npx` for a different reason: backgrounded,
# `$!` would be the pnpm wrapper's PID and killing that orphans the server (ci.yml).
npx next start -p 3000
curl -sS -D - -o body.html http://localhost:3000/docs/does-not-exist
```

| URL                                              | Status | Bytes   | Body                          |
| ------------------------------------------------ | ------ | ------- | ----------------------------- |
| `/does-not-exist` (control)                      | 404    | 82,424  | full 404 page                 |
| `/docs/does-not-exist`                           | 404    | 82,424  | full 404 page, byte identical |
| `/docs/does/not/exist/deep`                      | 404    | 82,424  | full 404 page, byte identical |
| `/docs/run-a-node/start-here/v99`                | 404    | 82,424  | full 404 page, byte identical |
| `/docs/stylus/quickstart` (control)              | 200    | 526,891 | the page                      |
| `/docs/run-a-node/start-here/v1`                 | 200    | 386,107 | the archived page             |
| `/docs/does-not-exist` + `Accept: text/markdown` | 404    | 0       | empty, and deliberately so    |
| `/docs/does-not-exist.md`                        | 404    | 0       | empty, and deliberately so    |
| `/llms.mdx/docs/does-not-exist/content.md`       | 404    | 0       | empty, and deliberately so    |

The three HTML 404s carry the same `ETag` as `/does-not-exist` and diff clean against it, because
all four are one prerendered `/_not-found` response. Strip `<script>` blocks before grepping a body:
a **200** docs page also contains the 404 copy, inside the router's prefetched flight payload, which
is why `scripts/static-docs-http.test.mjs` matches on `documentOnly(html)`.

**The three markdown shapes answer 404 with an empty body on purpose.** A client that asked for
`text/markdown` has no use for 82 KB of HTML chrome, and the reader-facing case, a browser following
a dead link, never takes that path. They are worth re-checking only if something starts linking to
`.md` URLs.

### Cache-Control, and why markdown negotiation carries `Vary: Accept`

A prerendered route serves `cache-control: s-maxage=31536000` with `x-nextjs-cache: HIT`, so docs
pages are now edge-cacheable where they previously carried
`private, no-cache, no-store, max-age=0, must-revalidate` on every request. The 404 response keeps
those no-store directives, being Next's own `/_not-found` output rather than ours.

That year-long `s-maxage` is why markdown negotiation carries `Vary: Accept`. `proxy.ts` rewrites an
`Accept: text/markdown` request for a docs URL onto that page's `/llms.mdx/**/content.md` path, so
one URL can answer either with HTML or with a markdown body a shared cache will hold for a year.
Under `next start` the cache keys on the rewritten path and the bare URL without the header still
returns HTML, so nothing leaked locally either way; the header is what keeps that true on a cache
that keys on the original URL instead. Next sets its own `Vary` on the app-page response, so
`patches/next@16.3.4.patch` turns that `setHeader` into `appendHeader`, which is what stops the
framework value overwriting the proxy's. **Vercel's edge keying for a proxy rewrite is a different
code path and has still not been confirmed on a preview.** Confirm it by fetching one docs URL with
and without the header against a preview deployment and checking that the bare one is still HTML.

### The accepted costs

- **A page added without a rebuild 404s rather than being stale**, and a failed build takes _new_
  pages offline. Existing pages keep serving the last good build. This is the direct consequence of
  `dynamicParams = false` and it is the trade the ticket accepted.
- **Build time and disk.** Roughly +25 s and +370 MB of `.next` against the pre-FS-2698 build (three
  interleaved cold builds each: 48.2/44.8/37.2 s and 653 MB before, 78.5/66.3/68.3 s and 1.0 GB
  after). The bought work is 352 page renders (349 live pages plus the three archives), 349 satori
  images and 349 markdown files that used to happen on first request.

**Do not count prerendered pages from the route table.** It never states the total: the parent line
prints bare as `/docs/[[...slug]]`, with no `●` marker at all, and the markers sit on three sample
child paths plus a `[+349 more paths]` line, so the count is only recoverable by adding the samples
to the remainder. An earlier shape of that same output produced the old "339 docs pages prerendered"
misreading and its correction. Count `.next/prerender-manifest.json`, or
`find .next/server/app/docs -name '*.html'`.

### What was tried and rejected

- **A Suspense boundary** (`app/docs/loading.tsx`) removes the error shell but answers **200**,
  which is worse than an empty 404.
- **`global-not-found`** never runs here: the `/docs/[[...slug]]` segment pattern still matches
  everything under `/docs`, so the URL is a matched route whose params were rejected, not an
  unmatched one.
- **Checking the slug in `proxy.ts`** needs the page list, and importing `lib/source` there takes
  the traced proxy closure from 1.70 MB to 28.26 MB with a 26.6 MB chunk on every cold start. A
  generated slug manifest instead is a feature whose failure mode is 404ing a live page.
- **`connection()` from `next/server`** was measured against the older dynamic shape and made every
  docs page a 500. It is a render-time bailout, so it could not stop a fallback shell being
  generated. It is history now that the route is static, and it is recorded here only so the
  experiment is not repeated.

### Two things that would regress this

**Reading `searchParams` in the page again.** That makes the route dynamic, which empties
`generateStaticParams` of effect and brings the `__next_error__` shell back with it. The two
tickets share one root cause and would come back together.

**Enabling Cache Components.** Next 16.0.0 removed `dynamic`, `dynamicParams`, `revalidate` and
`fetchCache` from the route segment config when `cacheComponents` is on, and exporting
`dynamicParams` then fails the build outright with "Route segment config `dynamicParams` is not
compatible with `nextConfig.cacheComponents`". The migration guide's replacement is to call
`notFound()` in the page for a param that does not resolve, which is precisely the shape that
produced the empty shell here, so enabling that flag is a migration for this route and not a flag
flip. `next.config.mjs` does not set it today. If it ever does, re-run the curl recipe above before
believing the route still 404s visibly.

## Design specs

Longer-form design documents live in `.claude/docs/superpowers/specs/`:

| Spec                                             | Topic                          |
| ------------------------------------------------ | ------------------------------ |
| `2026-07-09-partials-registry-design.md`         | Partials registry model        |
| `2026-07-10-references-glossary-design.md`       | Glossary and inline references |
| `2026-07-14-full-nav-scaffold-design.md`         | Navigation scaffold            |
| `2026-07-14-fumadocs-styling-adoption-design.md` | Styling adoption               |
| `2026-07-14-import-remaining-content-design.md`  | Content import                 |
| `2026-07-17-partial-versioning-design.md`        | Partial versioning             |
| `2026-07-29-arbitrum-docs-reskin-design.md`      | Reskin                         |
| `2026-08-13-arbitrum-docs-content-gap.md`        | Content gap analysis           |

That directory is tool-specific. If Claude Code is dropped, these should move to `docs/specs/`.
