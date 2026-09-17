# Contributing to the Arbitrum docs

Thank you for considering a contribution to the Arbitrum documentation portal. This repo is a
Next.js 16 / Fumadocs site. It replaced the Docusaurus site at
[`OffchainLabs/arbitrum-docs`](https://github.com/OffchainLabs/arbitrum-docs), which is archived, and
the content model, tooling and gates are different enough that this document is a rewrite, not a
port, of that repo's `CONTRIBUTE.md`. If something here
conflicts with [README.md](README.md) or [INTERNALS.md](INTERNALS.md), those two are canonical —
this file exists to get a new contributor from zero to an open PR.

## Setup

```bash
pnpm install      # runs a postinstall that generates .source/
pnpm dev          # http://localhost:3000
```

Node `22.x` (`>=22 <23`, enforced by `engines`) and pnpm 10. Other Node majors are rejected.

**Browse on `localhost:3000`, not `127.0.0.1`** — on `127.0.0.1` React does not hydrate and every
component looks broken, which is a common false alarm when checking a content change.

## Add or edit a page

Every non-partial `.mdx` page needs five frontmatter fields. A missing or invalid one fails the
build:

```mdx
---
title: 'How to run a full node'
description: One-line summary shown in search results and social cards.
content_type: 'how-to'
author: your-github-handle
sme: reviewing-sme-handle
---
```

`content_type` must be exactly one of: `how-to`, `concept`, `quickstart`, `tutorial`, `reference`,
`troubleshooting`, `faq`. Pick the type that matches what the reader is trying to do, not just
what feels closest — see [Document type conventions](#document-type-conventions) below. Optional
fields: `sidebar_label`, `user_story`, `draft`.

**Sidebar order comes from `meta.json` in each content directory, not from file names.** Add your
new page's basename to the `pages` array in the `meta.json` for that directory, in the position
you want it to appear. `meta.json` also supports `...` rest-globs, `---Separator---` headings,
`[text](url)` external links, and `!exclude`. Run `pnpm nav:check` after touching one.

## Reuse a partial before you write new prose

Reusable `_`-prefixed fragments live in `content/partials/`, outside the routed doc tree so they
can never be served as their own page. **Before writing a banner, note, config table, or
troubleshooting block, search [`content/partials/CATALOG.md`](content/partials/CATALOG.md)**
(⌘F by intent — title, summary, tags) and reuse the partial instead of duplicating the prose. The
catalog gives you a copy-paste snippet for each entry.

```mdx
<!-- From a doc page: root-anchored, so moving the page later never breaks the include -->

<include cwd>content/partials/launch-arbitrum-chain/_raas-providers-notice.mdx</include>
```

```mdx
<!-- From another partial: MUST be file-relative, never cwd -->

<include>../_hardware-requirements.mdx</include>
```

The relative form is required inside a partial; a `cwd` include there crashes the build outside
the normal docs pipeline, and `pnpm partials:check` enforces the distinction.

If nothing in the catalog fits: create `content/partials/<area>/_your-partial.mdx` with no
frontmatter (`<include>` strips it), reference it, then run `pnpm partials:catalog` to regenerate
`CATALOG.md` and `manifest.json` — never hand-edit either. Optionally curate its title, summary,
and tags in `content/partials/registry.json`.

## Use a variable, don't hardcode a value

Values that move on a release cadence — version tags, chain parameters, node image names — live
once in [`content/vars.json`](content/vars.json) and render via `<Var name="..." />`, which needs
no import:

```mdx
The current Nitro release is <Var name="nitroVersionTag" />.
```

To change a value, edit `vars.json` and run `pnpm vars:check`. To add a **new** variable, add the
key to both `vars.json` **and** the `varsSchema` in `content/vars.ts` — miss either side and the
gate fails, because the schema is a strict object that would otherwise silently drop the key and
render the literal string `undefined` on every page that uses it.

## Move or rename a page

```bash
pnpm move-doc <from> <to>
```

This rewrites every internal link that pointed at the old path (in whatever form it was written —
absolute, relative, `.mdx`-suffixed, `<include>`), moves the file with `git mv`, updates the
surrounding `meta.json`, and records the redirect in `redirects.config.mjs` for you. **Never
hand-edit between the `AUTO-GENERATED` markers in `redirects.config.mjs`**, since `move-doc` owns that
block. Use `--dry-run` first to preview the changes, and confirm afterward with `pnpm check-links`.

`move-doc` also retargets the two hand-written maps in `scripts/lib/legacy-redirects.mjs` that decide
where legacy `docs.arbitrum.io` URLs point, if either names the page, and prints a note when a
`redirects.legacy.mjs` entry is left one hop long. That file is hand-maintained: add or retarget a
legacy redirect by editing it directly, then prove the destination with `pnpm redirects:check`
against a running site.

## Gates to run before you push

```bash
pnpm types:check       # regenerates .source/, generates Next types, tsc --noEmit — the main gate
pnpm test              # node --test over the tooling scripts in scripts/
pnpm vars:check        # every <Var name> resolves
pnpm nav:check         # meta.json navigation integrity
pnpm partials:check    # includes resolve, no routing leak, catalog fresh
pnpm references:check  # glossary ids + <Reference> targets
pnpm check-links       # broken internal doc links and MDX fragments
```

These seven are exactly what `.github/workflows/ci.yml`'s blocking `Gates` job runs (it also runs
`versioned-docs-check.mjs`, which only matters if you touched `content/_versions/`). A green PR
does not by itself mean the content renders correctly: `types:check` proves the frontmatter
schema, not the render — it exits 0 on a page that serves a literal `:::` or the string
`undefined`. **Always open a changed page on `http://localhost:3000` and confirm it looks right**,
in light and dark mode if you touched styling.

Two more checks report in CI without blocking merges yet — `pnpm format:check` and
`pnpm content:lint` — because both still fail on pre-existing debt elsewhere in the repo. Run
`pnpm format` on the files you touched and `pnpm content:lint` over the tree anyway, and read past
the pre-existing findings to check you didn't add one; don't grow the backlog even though CI won't
stop you.

## Document type conventions

Pick the type that matches what the reader is trying to do:

| Content type    | Purpose                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| Quickstart      | Fast onboarding with hands-on, step-by-step instructions for one specific audience |
| How-to          | Task-oriented procedural guidance                                                  |
| Concept         | Explains what something is and how it works                                        |
| Tutorial        | A comprehensive, guided learning experience                                        |
| Reference       | Lists and tables of things — API endpoints, developer resources, flags             |
| Troubleshooting | Common problem/solution scenarios                                                  |
| FAQ             | Frequently asked questions                                                         |

This isn't an exhaustive taxonomy, but it covers most of what we write. If you're unsure, look at
an existing page of the type you think you're writing and match its shape.

## Style conventions

These are the minimum guidelines for new content going forward; a lot of existing content
predates them and gets brought up to spec incrementally, not all at once.

1. **Sentence case.** Capitalize titles, headers, and sidebar labels like a sentence — "Deploy your
   smart contract", not "Deploy Your Smart Contract".
2. **Descriptive link text.** Never anchor a link to "here" or "this" — link text should describe
   the destination, so a reader skimming links alone still understands the page. When linking to
   another doc, use that doc's title verbatim.
3. **Separate procedural from conceptual.** A how-to or quickstart should carry only the
   conceptual detail the reader needs to finish the task at hand; put broader conceptual material
   in a `concept` page and link to it "just in case."
4. **Write for a specific reader.** Don't try to write for everyone. State your assumptions about
   the reader's prior knowledge near the top of the page.
5. **Lead with what matters.** Put the outcome or the value to the reader first, then build toward
   task completion — don't bury the point.
6. **American English, plain language, short sentences.** Address the reader as "you"; contractions
   are fine; avoid jargon your target reader won't recognize.

The full editorial standard — content-type selection criteria, a plain-language checklist, and the
Quicklook/glossary-linking convention — lives in Offchain Labs' pattern guide. It has not been
ported into this repo yet, so for now refer to the upstream copy on GitHub:
[`arbitrum-docs/docs/Offchain-pattern-guide.md`](https://github.com/OffchainLabs/arbitrum-docs/blob/master/docs/Offchain-pattern-guide.md).
If this repo starts drifting from it, port it into `content/docs/` (it is a real doc page
upstream, with its own frontmatter) rather than leaving contributors to jump repos for the style
guide.

## Opening a pull request

Fill in the [PR template](.github/pull_request_template.md) — it asks for a description, the
document type, and a checklist mirroring the gates above. Branch from `main` and open the PR
against `main`. Every push runs CI; check the `Gates` job before requesting review.

## Third-party content

Docs that help readers use another product, service, or protocol alongside Arbitrum (rather than
docs about Arbitrum itself) are third-party content. We generally don't accept promotional
material — a page needs to give the reader actionable guidance, not just describe a product. If
you're not sure whether your contribution counts as third-party content, ask before you write a
full draft.
