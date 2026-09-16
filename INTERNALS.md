# INTERNALS

How this codebase works, and why it is built the way it is. For the docs team and anyone
maintaining the tooling.

Task-level instructions — setup, writing a page, using a partial — live in [README](README.md).
`CLAUDE.md` is machine-facing and duplicates parts of this file for coding agents; **this file is
canonical for humans, and the one to edit first.**

## Contents

- [What Fumadocs is](#what-fumadocs-is)
- [Coming from Docusaurus](#coming-from-docusaurus)
- [The pipeline](#the-pipeline)
- [`source` is a choke point](#source-is-a-choke-point)
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
- [The Node runtime](#the-node-runtime)
- [Analytics](#analytics)
- [The gates](#the-gates)
- [Upstream drift](#upstream-drift)
- [What nothing catches](#what-nothing-catches)
- [Known trade-off: no static prerendering](#known-trade-off-no-static-prerendering)
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
`---Separator---`, `[text](url)` external links, and `!exclude`. There is no global sidebar file.

**The catch-all route.** One file, `app/docs/[[...slug]]/page.tsx`, renders every docs page. It
takes the slug segments, calls `source.getPage()`, and renders. Adding an `.mdx` file creates a
route with no wiring; there is no per-page React file.

**The action row** under the title holds `MarkdownCopyButton`, `ViewOptionsPopover`,
`RequestUpdateLink` (`components/RequestUpdateLink.tsx`, the port of the Docusaurus `HeaderBadges`
"Request an update" badge: a server-rendered link to a prefilled GitHub issue, built from
`gitConfig`, `page.url`, and `NEXT_PUBLIC_SITE_URL`), and, on versioned pages only,
`VersionSwitcher`. The [last updated](#last-modified-dates) line sits above it, between the
description and the row.

**Slugs are the file path minus the extension**, with a trailing `index` dropped —
`content/docs/stylus/quickstart.mdx` serves at `/docs/stylus/quickstart`, given `baseUrl: '/docs'`.

## Coming from Docusaurus

Most of the team is arriving from `OffchainLabs/arbitrum-docs`. The differences that actually cause
mistakes:

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

The numeric-prefix rule is the sharpest edge when porting URLs: a path that Docusaurus served at
`/foo/bar` will serve at `/02-foo/bar` here unless the directory is renamed or a redirect is added.

`@fumadocs/cli` exists but only **installs UI components**. It does not move, rename, or restructure
docs, and it does not manage redirects. Every tool in `scripts/` exists because nothing upstream
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
(`summary_large_image`, site `@arbitrum`). The canonical deliberately uses `page.url`, which
carries no query string, so an archived `?v=` view canonicalizes to the live page rather than
splitting it in two.

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
enforcement point. Now that 703 routes prerender (see the
[known trade-off](#known-trade-off-no-static-prerendering)), the root layout's module scope does run
at build and would throw too. Keep both: the docs route itself still never prerenders, so the
config-level check is what covers a build that touches no prerendered route. The rule used to be
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

`app/(home)/page.tsx` sets no canonical of its own and is the one remaining page without one.

## Partials

Reusable `_`-prefixed fragments live in `content/partials/` — **outside** the doc collection `dir`
entirely, so they can never be routed. No glob exclusion is needed. Two consumption paths, both
tracked by the tooling:

**`<include>` directive** (build-time splice). Doc→partial includes use the root-anchored
`<include cwd>content/partials/…</include>` form, so moving a page never breaks its includes.

**Partial→partial includes must be file-relative** (`<include>../x.mdx</include>`). A partial may
be compiled outside the docs pipeline when ESM-imported, and there `fumadocs-mdx`'s `cwd` context
is undefined and crashes the build. `partials:check` enforces the distinction.

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

Values mirror upstream `arbitrum-docs/src/resources/globalVars.js`. Keep them in sync while that
site is still live.

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

The upstream Docusaurus site needs two copies (a client-redirects plugin for in-app navigation plus
a synced `vercel.json` for the edge). Next needs one. The sync step is what disappeared in the
migration, not the generation step.

`redirects()` runs **before** `proxy.ts`, so a redirected URL gets markdown negotiation on the
destination, not on the first hop.

Both blocks in `redirects.config.mjs` are generated. Never hand-edit it.

**Moved pages.** `pnpm move-doc <from> <to>` writes the old→new URL between the `AUTO-GENERATED`
markers. It also retargets the moved path if either drift map names it: a `RENAME_MAP` value (or the
`to` field of a `merge: true` entry) in `scripts/lib/tree-compare.mjs`, and a `guttedAllowlist` entry's
`local` field in `scripts/data/upstream.config.json` (see [Upstream drift](#upstream-drift)). Before
this, a move left those maps pointing at a path that no longer existed, which only surfaced as a
`pnpm test` failure in whatever unrelated PR happened to run next — the maps themselves gave no
warning. `scripts/lib/drift-maps.mjs` does the rewrite; `RENAME_MAP` keys (upstream/Tree A paths) and
`absentAllowlist` (which names only an upstream path, never a local one) are never touched, because
only local paths move.

Three things about that rewrite are load-bearing, and each exists because the alternative fails
quietly:

- **It edits only inside the `RENAME_MAP` object literal.** `tree-compare.mjs` also declares
  `SECTION_MAP`, whose values are bare section prefixes (`'stylus'`, `'oracles'`, `'run-a-node'`). A
  whole-file match for a top-level page's path would rewrite one of those and silently remap an
  entire upstream section, while reporting it on the CLI as a `RENAME_MAP` change.
- **A missed match aborts the step.** The rewrite is textual and single-quote-only, so reformatting
  `tree-compare.mjs` to double quotes, or writing an entry as a template literal, would match nothing
  and leave the stale path in place, which is the original bug again with no warning. After
  rewriting, `drift-maps` imports `tree-compare.mjs` and checks its substitution count against the
  parsed `RENAME_MAP`; a disagreement throws and names the path. It also warns, without failing, when
  the destination is already another entry's target, since `pairTrees` rejects two upstream pages
  claiming one local file unless every entry involved declares `merge: true`.
- **It runs last and writes both maps or neither.** Every read, rewrite, verification and Prettier
  pass happens before the first write, and `move-doc` calls it after the redirect is appended, so a
  formatter or parse failure cannot cost the redirect or leave one map retargeted and the other not.

**A move can still leave `MANUAL_DESTINATIONS` stale.** `scripts/lib/legacy-redirects.mjs` keeps a
third hand-written map of local paths, as site URLs rather than content-relative paths, and
`move-doc` does not touch it. Moving a page named there fails
`scripts/generate-legacy-redirects.test.mjs` ("every hand-written destination still names a live
page") in whatever PR runs `pnpm test` next, the same shape of failure this section exists to
prevent. Retargeting it correctly also means regenerating `redirects.legacy.mjs`, which needs the
sibling `arbitrum-docs` checkout that `move-doc` deliberately does not require, so it is tracked
separately as FS-2697. Until then, after moving a page, grep `MANUAL_DESTINATIONS` for its old URL.

**And `VERSIONED` in `lib/versions.ts`, which is worse, because nothing catches it.** That registry
keys the partial versioning registry by canonical slug (`'run-a-node/start-here'`), `move-doc` does
not touch it, and no gate asserts its keys name a live page: `scripts/versioned-docs-check.mjs` only
warns about uncommitted edits to versioned documents and always exits 0. Moving a versioned page
therefore leaves a dead key, the page silently loses its version dropdown and its `?v=` archives
become unreachable, and `pnpm test` stays green — measured, by moving `run-a-node/start-here.mdx`
and watching 346/346 pass with `lib/versions.ts` untouched. Retargeting it is a judgement call
(`archivePath` mirrors the old slug on every current entry but is not required to), so after moving
a versioned page, retarget its `VERSIONED` key by hand.

**Legacy `docs.arbitrum.io` URLs.** `pnpm redirects:legacy` regenerates `redirects.legacy.mjs`.
Legacy URLs were served at the site root (`/stylus/using-cli`) and this site serves docs under
`/docs`, so sources stay root-level (that is what real inbound links look like) and destinations
are rewritten to `/docs/…`. The output is committed, so builds never need the sibling repo; only
regeneration does. The generator locates that checkout the way `scripts/data/upstream.config.json`
describes (`--upstream <dir>`, then `UPSTREAM_DOCS_REPO`, then `repo`, then the probe paths), so it
runs from a worktree without a flag.

**Two kinds of source feed in, and both flow through the same resolution order.**

- **Upstream's own redirect sources**, from the sibling repo's `vercel.json`: URLs upstream had
  already moved before the migration.
- **Upstream's canonical page URLs**, derived from its `docs/` tree by
  `scripts/lib/upstream-pages.mjs`. These were never redirect sources anywhere, so until 2026-09-11
  nothing mapped them and all ~289 of them would have 404'd at cutover, purely because of the
  `/docs` prefix. They are now the larger half of the map.

Deriving those canonical URLs means reimplementing Docusaurus's routing, because upstream sets
`routeBasePath: '/'` and the computed slug _is_ the URL. The rules, transcribed from
`@docusaurus/plugin-content-docs` and verified against upstream's published `/llms.txt`:

- Drop the extension, and strip a `NN-` number prefix from every path segment, except date-like
  and version-like names (`2024-06-…`, `7.0-…`), which upstream leaves alone.
- A file named `index`, `README`, or the same as its parent directory takes the directory's URL.
- Frontmatter `id` renames the last URL segment; frontmatter `slug` replaces the URL outright and
  wins over `id`. Both are in use upstream (`use-supras-price-feed-oracle.mdx` serves at
  `…/supras-price-feed`; `get-started/overview.mdx` serves at `/`).
- `sdk/`, `api/`, `hosted-pdfs/`, `superpowers/`, any `partials/` directory, anything `_`-prefixed,
  and `Offchain-pattern-guide.md` are not pages. This matches upstream's own
  `nonCanonicalRoutePatterns`.
- Category landings that exist only in `sidebars.js` (a `generated-index` link with an explicit
  `slug`, such as `/stylus`) are real indexable URLs upstream, so they are seeded too.

The generator then resolves a destination in this order, declining rather than guessing. For a
canonical URL the target is the URL itself, because the page was live there; for a redirect it is
the end of upstream's own chain.

1. **`MANUAL_DESTINATIONS`** — hand-verified legacy destination → local page. A value may carry an
   `#anchor`; the page part must resolve or the generator throws.
2. **Self-URL** — the legacy path still names a live page here under `/docs`. Upstream moved the
   page and this site did not, so serve ours. This is the rule that resolves most canonical URLs.
3. **Section renames** — whole sections that moved wholesale (`/run-arbitrum-node` → `/run-a-node`).
   Deep restructures are deliberately absent: their pages moved individually, so a prefix rule
   would produce confidently-wrong destinations.
4. **Exact title**, when exactly one local page carries the upstream page's frontmatter title
   verbatim. Ahead of the basename, because a title identifies a page where a basename only
   suggests one. This site pairs a `features/…/choose-X` page answering "why would I want X" with
   a `configuration/…/X` how-to, and the two often share a basename or differ only by a `config-`
   prefix; the basename alone kept picking the "why" half, so a reader after a procedure landed on
   a page that has none. Declines when two local pages share the title, _and_ when two upstream
   pages shared it, which is the same asymmetry rule 5 guards against: there the legacy path was
   doing the disambiguating and the title cannot. Two upstream pages folded into one here may well
   be deliberate, but that is a judgement, and judgements belong in `MANUAL_DESTINATIONS` rather
   than being inferred from a title collision. Declining sends the source to the todo file, where
   the tripwire makes someone decide.
5. **Basename fallback** — accepted only when exactly one local page carries that slug _and_ the
   basename was unique upstream too. Where the legacy path was doing the disambiguating, the
   fallback cannot, and declines.
6. **`SECTION_LANDINGS`**, the nearest live section, for a page upstream has and this site has not
   ported. Not an equivalence, and last on purpose: the day the page is ported, rule 2 matches
   first and the entry goes inert on its own.

It also follows upstream's own redirect chains to their terminal destination first. Many upstream
entries point at a URL that is itself a redirect source, up to three hops deep, so a raw
`destination` is often not where a reader ends up.

**A source that names a live route here is skipped, not emitted.** Next runs `redirects()` before
anything renders, so such a redirect wins over the route and makes it unreachable. Upstream's
homepage `/` is the standing example. `reservedRouteReason` in `scripts/lib/upstream-pages.mjs`
holds the list: the root, `/llms*`, `/og`, `/api`, `/img`, the `public/` asset directories, and
the icon and PDF files. `/docs` is checked against the content tree instead of banned wholesale.

**The guiding rule: a redirect to a plausible-but-wrong page is worse than a 404.** It silently
sends readers somewhere wrong, and `redirects:check` cannot catch it, because the destination
exists.

**`MANUAL_DESTINATIONS` and `SECTION_LANDINGS` are hand-written, so a test pins them against the
content tree.** The generator throws when an entry it _reaches_ names a missing page, but it only
reaches an entry whose source is in upstream's corpus on that run, so an entry orphaned by
`pnpm move-doc` would otherwise rot silently into a redirect to a 404. `pnpm test` walks
`content/docs` and asserts every non-external value in both maps still resolves — the same guard,
for the same reason, as the one the drift allowlists carry.

Anything unresolvable lands in `redirects.legacy.todo.json`. **That file reached `[]` on
2026-08-31, stayed `[]` when canonical URLs were added on 2026-09-11, and is a tripwire, not a
backlog.** A non-empty todo after a regeneration means upstream added a page or a redirect this
site cannot resolve; map it in `MANUAL_DESTINATIONS` (or `SECTION_LANDINGS`, when this site has no
such page yet), confirming the upstream page's frontmatter title against the local candidates,
rather than leaving it parked.

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

`proxy.ts` does exactly three things:

1. **Request tracking** for markdown and `llms*.txt` fetches, production only (below).
2. An explicit **bypass list** of routes served verbatim: `/_next/`, `/img/`, `/favicon.ico`,
   `/sitemap.xml`, `/robots.txt`, `/llms*`, `/og/`, `/api/`.
3. `.md`-suffix rewrites plus `Accept: text/markdown` content negotiation to the markdown route.

**A new top-level route belongs in that bypass list**, or markdown negotiation will try to rewrite
it.

Re-adding localization means restoring `defineI18n`, the `i18n` argument to `loader()`, a `[lang]`
segment, and `createI18nMiddleware`.

### Request tracking

`proxy.ts` also records who fetches the markdown, continuing the `llms_file_fetched` PostHog event
upstream's `middleware.ts` produced. The point is to answer "which pages are AI assistants and
crawlers actually reading", which server logs alone do not.

**It runs before the bypass list**, because `/llms.txt`, `/llms-full.txt` and the `/llms.mdx/`
mirrors are all in that list and are exactly the fetches worth counting.

Four request shapes are tracked, and the classification lives in `lib/llms-tracking.ts`:

| Request                                     | Tracked as        | `file_type` |
| ------------------------------------------- | ----------------- | ----------- |
| `/llms.txt`, `/llms-full.txt`               | as-is             | `index`     |
| `/docs/<slug>.md`                           | as-is             | `page`      |
| `/llms.mdx/docs/<slug>/content.md`          | `/docs/<slug>.md` | `page`      |
| `/docs/<slug>` with `Accept: text/markdown` | `/docs/<slug>.md` | `page`      |

All three markdown shapes normalise to the one canonical `.md` path, so a page's fetches are one
number rather than three. **Each request is counted once:** a Next rewrite does not re-enter the
proxy, so `/docs/x.md` fires one event, not a second one for the mirror it rewrites to. A `.md` on
a legacy URL is not tracked either, because it is answered with a 307 and the destination request
is tracked instead.

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
hand-registered pages are versioned.

`scripts/versioned-docs-check.mjs` text-parses `lib/versions.ts` rather than importing it, because
no plain-node script can import `lib/source` — neither the `collections/*` alias nor TypeScript
resolves. `redirects-check.mjs` hits the same wall, which is why it reads `/llms.txt` off a running
site instead.

## Glossary and inline references

`content/glossary/*.mdx` is a reference collection with its own shape — `{ id, title, sortAs? }`,
**not** the page contract. It is surfaced by `<Reference>`, `<Term>`, and `<ReferenceList>` via the
registry in `lib/references.ts`.

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
time Vercel moves. Upstream `arbitrum-docs` carries the same file with the same content.

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
| `nav:check`                | `meta.json` navigation integrity                                              |
| `partials:check`           | Unresolved includes, routing leaks, stale catalog, `cwd` include in a partial |
| `versioned-docs-check.mjs` | Archived-page registry drift                                                  |
| `references:check`         | Glossary ids and `<Reference>` targets                                        |
| `faq:check`                | A `faqsId` with no matching entry in the FAQ data                             |
| `images:presence`          | A markdown image with a remote src, which renders as a 500                    |
| `check-links`              | Broken internal doc links                                                     |
| `contracts:check`          | The generated contract-address partial matches `@arbitrum/sdk`                |
| `format:check`             | Prettier style drift                                                          |
| `content:lint`             | MDX structural defects, rules A1 through A6                                   |

`check-links` exists because Fumadocs has no equivalent of Docusaurus's `onBrokenLinks: 'throw'`.
`pnpm build` chains it ahead of `next build`, so a broken link also fails the Vercel deploy.

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

**Run by hand only:** `cli:check`, `redirects:legacy`, and the network mode of `images:check`.
`images:check` reaches out to third-party hosts, so its result depends on somebody else's uptime;
its offline sibling `images:presence` does run in CI. `drift` is worth running by hand for a local
check but is no longer manual-only: the `drift` job below runs it weekly. `redirects:check` is no
longer hand-only for a PR either — it runs as the last step of the `Build` job, against `next start`
on localhost (see [Redirects](#redirects)). It is not in the blocking `Gates` job because it needs a
running site, and the only cheap way to get one is to reuse the build that `Build` already does;
promoting `Build` promotes it too. It is still available by hand with `--base-url`, against a local
`pnpm dev` or any other URL.

`upstream-refresh.yml` runs Mondays at 08:00 UTC and on `workflow_dispatch`, in two independent
jobs:

- **`refresh`** runs `nitro:check-release`, then `precompiles:generate`, `contracts:generate` and
  `cli:generate`, opening `automated/upstream-refresh` as a PR if anything changed. It never writes
  to `main` and no-ops when the tree is clean.
- **`drift`** clones the still-live `arbitrum-docs`, runs `upstream-drift.mjs` against it, and keeps
  a single issue titled "Upstream drift" in sync with the report: created or its body replaced while
  anything is absent or gutted, commented and closed once the report comes back empty. It holds
  `issues: write` and nothing else. **It is deleted at cutover (plan M-52)**, when there is no longer
  an upstream to drift from.

The two jobs have no `needs` between them on purpose, so a failing generator never hides a drift
report and a missing upstream clone never blocks the refresh PR.

`upstream-drift.mjs` exits 1 both when it finds drift and when it refuses to run at all (missing
tree, or a clone stale enough to under-report), so the job cannot read the exit code alone. It
requires the `N absent, M gutted` summary to appear somewhere on stdout; anything else fails the job
instead of closing the issue on a report that never happened. **Match that line anywhere, and keep
its suffix optional.** The script prints a `comparing against <path>` line ahead of it, so a guard
pinned to line one never matches, and it appends `, N stale allowlist` exactly when an exemption has
expired, so a guard anchored at `gutted$` rejects the one case the report most needs to deliver.
Two details of the clone are equally load-bearing and easy to get wrong:

- It is cloned `--filter=blob:none`, **not** `--depth 1`. The report splits absent pages into DRIFT
  (added upstream after the port window) and MISS (should already have been ported) using
  `git log --diff-filter=A`, which a depth-1 clone cannot answer, so everything would come back MISS.
- `git clone` never writes `.git/FETCH_HEAD`, and `lib/git-freshness.mjs` treats a clone that has
  never fetched as an untrustworthy baseline. The job runs an explicit `git fetch` afterwards.

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

When `contracts:check` or `cli:check` fails it prints a line-level diff, so a reviewer can see
whether a value moved or only the formatting did. That diff is a real one, computed over a longest common
subsequence in `scripts/lib/line-diff.mjs`: comparing the two files by line index instead reported
every line after an insertion as changed, which on this 112-line partial meant 53 lines for a
two-line edit and defeated the point of printing it.

### Generated pages

Three things in `content/` are written by a generator and must never be hand-edited: the precompile
tables, the contract-address partial (both under `content/partials/`, see
[Partials](#partials)), and `content/docs/run-a-node/nitro/cli-flags-reference.mdx`.

The CLI flags page is the only generated file under `content/docs/`, so it is also the only one with
frontmatter a writer owns. `pnpm cli:generate` replaces only the region between
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

## Upstream drift

`pnpm drift` compares this repo against the upstream Docusaurus tree
(`OffchainLabs/arbitrum-docs`) and reports two things: **ABSENT**, an upstream page with no
counterpart here, and **GUTTED**, a page whose body here is under 70% of the upstream body.

**Finding the upstream checkout.** `scripts/lib/upstream-tree.mjs` resolves it from
`scripts/data/upstream.config.json`, first hit wins:

1. `--tree-a <path>`, which names the docs tree itself, resolved against the cwd
2. `UPSTREAM_DOCS_REPO`, which names the repo root, resolved against the cwd
3. `repo` in the config, resolved against **this repo's root**
4. `probePaths` in the config, in order, resolved against this repo's root

Config paths resolve against the repo root rather than the cwd because the checkout's position
relative to this repo is fixed while the cwd is not: the sibling clone sits at `../arbitrum-docs`
from the main checkout and `../../arbitrum-docs` from a worktree, and both are in `probePaths`. So
clone `arbitrum-docs` next to this repo and `pnpm drift` needs no arguments from anywhere.

**Pairing happens across the whole tree at once, not file by file.** `pairTrees` makes two passes:
directory-qualified matches first, each claiming its local file, then the bare-slug fallback for
whatever is left, never onto a file the first pass already claimed. One local file therefore pairs
with at most one upstream page.

**One local file pairs with at most one upstream page, in both passes.** The claim rule is not just
a tie-breaker for the fallback: two upstream pages can land on the same local file through the
directory match too, once a rename points them there. The single exception is a deliberate
two-into-one port, which both sides declare with `merge: true` in `RENAME_MAP` (upstream splits
batch-poster and assertion config across two pages; the port combined them). Without that flag the
collision is treated as accidental and the later page reports ABSENT, which is the honest answer,
because the tool cannot tell on its own whether the second page's content survived inside the first.

This matters because upstream keeps a concept page and a how-to page under the same basename:
`arbos`, `stf`, and `batchposter` versus `batch-poster`. Resolving one path at a time, the concept
page paired correctly by directory and the how-to page then grabbed the **same** local file through
the fallback. The report called three ported pages GUTTED at 0.12, 0.20 and 0.48, purely because it
was measuring a how-to against a concept page, and hid three unported how-tos behind those ratios.
One mispairing, two wrong answers, in opposite directions. A fourth case was quieter still:
upstream's `chain-config/costs/gas-optimization.mdx` paired against the unrelated Stylus
`best-practices/gas-optimization.mdx`, whose line count happened to clear 70%, so it produced no
finding at all. All four turned out to be plain renames once pairing was fixed.

**Three mechanisms change what the report says, and they are deliberately not one mechanism:**

| Mechanism         | Where                               | Means                                                        |
| ----------------- | ----------------------------------- | ------------------------------------------------------------ |
| `RENAME_MAP`      | `scripts/lib/tree-compare.mjs`      | The page was ported under a different name                   |
| `absentAllowlist` | `scripts/data/upstream.config.json` | The page was deliberately never ported                       |
| `guttedAllowlist` | `scripts/data/upstream.config.json` | The page was ported at parity; only the line count disagrees |

`RENAME_MAP` makes a page pair up so it is actually compared, which is the opposite of suppressing
it. The two allowlists suppress a verdict, and they stay separate because they are earned
differently. Absent-exempt means the content is not here on purpose. Gutted-exempt means the content
**is** here and the 70% ratio is counting Docusaurus `import` lines and inline grid boilerplate the
port does not carry. One combined list would let an exemption earned for one reason quietly cover
the other.

Every allowlist entry carries its reason, every `guttedAllowlist` entry also names its local
counterpart, and the script lists what it suppressed under `ALLOWED` rather than hiding it. Tests
pin both allowlists to their current contents and assert that every `RENAME_MAP` target and every
`local` path is a file that exists — so growing a list is a visible decision, and an entry that rots
into a no-op after a page moves fails the suite instead of quietly regrowing a false positive.

An absent-exempt page is still compared for GUTTED when a counterpart exists, so an exemption can
never hide content loss in whichever page absorbed it.

**Exemptions expire, by design.** Each allowlist entry records `reviewedUpstreamSha`, the git blob
hash of the upstream page as it read when a human granted the exemption. Drift recomputes that hash
on every run and re-flags the pair as `STALE-ALLOWLIST`, failing the run, once upstream edits the
page. An exemption is a judgement about one version of a page, not about the page forever, and
without an expiry the surest way to hide a real future gap would be to have already allowlisted the
page it lands in. An entry with no recorded hash counts as stale, so an entry added without one
demands a review rather than being trusted. To clear a stale entry, read both pages again and either
update the hash with `git -C ../arbitrum-docs hash-object docs/<path>` or drop the entry.

**Prefer a rename over an exemption whenever one is available.** `01-stf-gentle-intro.mdx` sat in
`absentAllowlist` on the theory that it had been absorbed into `deep-dives/stf.mdx`. Once pairing
was fixed it turned out to be an ordinary rename at ratio 1.74, so it moved to `RENAME_MAP`, where
the two pages get compared on every run instead of one of them being skipped. An exemption stops
looking; a rename keeps looking.

**The baseline has to be fresh.** A stale upstream clone does not make the comparison fail, it makes
it lie: everything upstream changed after the last fetch looks identical to ours. `drift` refuses to
run against a clone that has not fetched in 24 hours or is behind its upstream branch, so run
`git -C ../arbitrum-docs fetch` first if it has been a while. This guard is the reason drift can be
trusted at all, so do not route around it.

## What nothing catches

Every gate has a blind spot. These are the ones that have bitten:

- **Dead `#anchors`.** `check-links` validates pages, not fragments. A live page with a dead anchor
  passes. Verify by curling the page and grepping for `id="…"`.
- **Client components importing `lib/source`.** Costs megabytes in the browser bundle. No gate sees
  it.
- **Rendering.** `types:check` proves the schema, not the render. It exits 0 on pages that serve
  literal `:::`, `undefined`, or HTTP 500. Confirm content changes in a browser.
- **A redirect to the wrong-but-existing page.** `redirects:check` only proves the destination
  resolves.
- **A third-party image that has rotted.** Nothing in CI requests it, so a dead URL behind
  `<ImageZoom src="https://…">` is silent. `pnpm images:check` is the manual sweep. The one case CI
  does catch is a remote image in markdown syntax, via the offline `images:presence` gate.

**Browse on `localhost:3000`, not `127.0.0.1`.** On `127.0.0.1` React does not hydrate and every
component looks broken.

## Known trade-off: no static prerendering

Docs pages are rendered on every request and nothing about them is prerendered. **The reason is
`?v=`**, not a framework bug: `app/docs/[[...slug]]/page.tsx` `await`s `searchParams` to pick the
archived version, and a page that reads searchParams is dynamic by definition. So
`generateStaticParams` has nothing to prerender whatever it returns, and it returns `[]` rather than
enumerating 347 params for zero output.

Measured on Next 16.3.4 (2026-09-15) with a full `next build`, changing only whether the page takes
`searchParams`:

| Page signature                                    | Docs pages prerendered |
| ------------------------------------------------- | ---------------------- |
| `source.generateParams()`, `searchParams` present | 0                      |
| `source.generateParams()`, `searchParams` removed | 347                    |

**This used to be attributed to a Next 16.2.6 prerender crash, and that attribution was wrong by the
time it was read.** The crash does not reproduce on 16.3.4, so FS-2689 dropped
`--experimental-build-mode=compile` from `build`. Dropping it restored prerendering for everything
that _can_ prerender: 703 routes, being 348 `/og/docs/**` images, 348 `/llms.mdx/docs/**` paths, and
the seven static routes. The og images are the material win, since each one is a satori render that
previously happened on first request.

**That win is bought with build time, and it is a real regression.** Measured on one machine
(2026-09-15, Node 22.23.1, Next 16.3.4), `pnpm build` from a deleted `.next`, two runs each, a third
contended run discarded:

| Build                             | Wall clock     |
| --------------------------------- | -------------- |
| Before FS-2689 (compile mode)     | 24.7 s, 25.2 s |
| After FS-2689 (full `next build`) | 35.6 s, 35.7 s |

About +11 s, roughly +43%, for 348 satori renders and 348 markdown files that used to be produced on
first request instead. Do not read the old "no regression" note in the FS-2689 PR body: that number
was taken without controlling for cache warmth and points the wrong way. `.next` grows with it, from
606 MB to 644 MB, all of it the new static output.

Note also that the route table prints `● /docs/[[...slug]]` under "(SSG) prerendered as static HTML"
even though the route prerenders nothing. That marker reflects the presence of
`generateStaticParams`, not its output. Count `.next/prerender-manifest.json`, or
`find .next/server/app/docs -name '*.html'`, rather than reading the table. The same output shape is
what produced the "339 docs pages prerendered" misreading this section exists to undo.

**The prerendered routes are now edge-cacheable, and the docs pages are not.** A prerendered route
serves `cache-control: s-maxage=31536000` with `x-nextjs-cache: HIT`, where compile mode sent no
`Cache-Control` at all. That covers `/llms.txt`, `/llms-full.txt` and every `/llms.mdx/docs/**`
path, which is the second real win here. Docs pages are unaffected and still carry
`private, no-cache, no-store, max-age=0, must-revalidate`.

That year-long `s-maxage` is why markdown negotiation now carries `Vary: Accept`. `proxy.ts` rewrites
an `Accept: text/markdown` request for a docs URL onto that page's `/llms.mdx/**/content.md` path, so
one URL can answer either with HTML or with a markdown body a shared cache will hold for a year.
Under `next start` the cache keys on the rewritten path and the bare URL without the header still
returns HTML, so nothing leaked locally either way; the header is what keeps that true on a cache
that keys on the original URL instead. **Vercel's edge keying for a proxy rewrite is a different code
path and has not been confirmed on a preview.** Confirm it by fetching one docs URL with and without
the header against a preview deployment and checking that the bare one is still HTML.

**`export const dynamic = 'force-dynamic'` on the route is load-bearing.** Without it, a full build
with no static params makes Next prerender a fallback shell for the dynamic route; the searchParams
access poisons that shell, and every docs page then serves it as a 500 with digest
`DYNAMIC_SERVER_USAGE`. Compile mode hid that by never prerendering anything. Do not remove the
declaration while the page reads searchParams.

**It is also legacy, and only applies while Cache Components is off.** Next 16.0.0 removed
`dynamic`, `dynamicParams`, `revalidate` and `fetchCache` from the route segment config when
`cacheComponents` is enabled, and the migration guide lists `dynamic = 'force-dynamic'` as "not
needed. All pages are dynamic by default." `next.config.mjs` does not set `cacheComponents`, so the
export is live today. Enabling it is a migration rather than a flag flip, and this route has to be
rebuilt and re-checked as part of it: the declaration stops applying, and an unsuspended
`searchParams` read is an error under that model rather than the silent shell poisoning it is here.
`connection()` from `next/server`, which the Next docs offer as the forward-looking replacement for
`unstable_noStore`, is **not** a substitute and was measured rather than assumed. Swapping the
declaration for `await connection()` in both the page and `generateMetadata` and rebuilding turns
every docs page into a 500 with twelve `DYNAMIC_SERVER_USAGE` entries in the server log, and takes
`/docs/does-not-exist` from 404 to 500 as well. The reason is structural: `connection()` is a
render-time bailout, exactly what the `searchParams` read already is, so it cannot stop Next
generating the fallback shell in the first place. Only the route-level declaration does.

**`force-dynamic` and the empty `generateStaticParams` come out together, not one at a time.** They
are one workaround with two halves, exactly as `--experimental-build-mode=compile` and the empty
return were before FS-2689 removed those together. Once FS-2698 stops the route reading
`searchParams`, `force-dynamic` would suppress prerendering on its own, and the empty return would be
the only thing standing between the build and 347 static pages. Splitting them leaves the route
dynamic for a reason no longer written down anywhere.

Earlier revisions of this section described the behaviour as "ISR-on-first-request" with pages
"cached at the edge, then served statically on subsequent hits". That was never true once `?v=`
landed: the response carries `private, no-cache, no-store, max-age=0, must-revalidate`, before and
after this change alike.

To actually prerender docs pages, `?v=` has to stop coming from `searchParams`. That is **FS-2698**,
a change to the versioning URL contract in
[`2026-07-17-partial-versioning-design.md`](.claude/docs/superpowers/specs/2026-07-17-partial-versioning-design.md)
rather than a change to the route file. It would also fix the empty-bodied 404 under `/docs/*`
(FS-2688), because a statically routable docs route can carry `dynamicParams = false`, which turns an
unknown slug into an unmatched URL that serves `app/not-found.tsx` in full.

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
