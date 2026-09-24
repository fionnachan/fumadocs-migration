/**
 * Navigation-manifest rules, in one place, in plain JavaScript.
 *
 * **Why this is `.mjs` and not `.ts`, next to the TypeScript it serves.** Two things have to apply
 * this rule and they run in different worlds. `lib/docs-navigation.ts` is app code compiled by
 * Next, and it throws so that a dev server fails loudly instead of rendering a wrong sidebar.
 * `scripts/lib/nav.mjs` is plain Node behind `pnpm nav:check`, the blocking gate. One module
 * imported by both means the enforcing copy and the tested copy are the same copy. Plain `.mjs`
 * rather than importing the `.ts` directly, because Node's type stripping prints a
 * `MODULE_TYPELESS_PACKAGE_JSON` warning onto the gate's stderr for every such import. Same shape,
 * and for the same reasons, as `lib/site-url.mjs`. `tsconfig.json` sets `allowJs`, so
 * `lib/docs-navigation.ts` imports this with inferred types and no `.d.ts`.
 *
 * Takes the manifest sections as an argument rather than reading the JSON, so both callers and the
 * tests pass their own.
 */

/**
 * Every `page` URL the manifest claims more than once, with the entry names that claim it.
 *
 * A `page` entry is the canonical claim on a URL: it becomes the real page node that gives the
 * destination its sidebar root. Claiming one URL twice therefore always means one of the two
 * entries is naming a page it does not open, and the page it was meant to name falls through into
 * its section's "Additional guides" group. Nothing else catches it, because both entries name a URL
 * that exists (FS-2740).
 *
 * Two kinds of repeat are deliberately not reported:
 *
 * - `href`, which builds a display-only separator node claiming nothing. Repeating one is the
 *   documented way to pin a cross-section shortcut, and the manifest does it for sixteen URLs.
 * - `folder`, which expands against the real content tree. A static read of the manifest cannot
 *   say which pages a repeat would duplicate, so that question belongs to the transformer.
 *
 * @param {{ children?: unknown[] }[]} sections Manifest sections, as in `lib/docs-navigation.json`.
 * @returns {{ url: string, names: string[] }[]} One entry per over-claimed URL, in manifest order.
 */
export function duplicateManifestPages(sections) {
  /** @type {Map<string, string[]>} */
  const claims = new Map();

  const walk = (items) => {
    for (const item of items ?? []) {
      if (typeof item?.page === 'string') {
        claims.set(item.page, [...(claims.get(item.page) ?? []), item.name ?? '(unnamed)']);
      }
      if (Array.isArray(item?.children)) walk(item.children);
    }
  };
  for (const section of sections ?? []) walk(section?.children);

  return [...claims]
    .filter(([, names]) => names.length > 1)
    .map(([url, names]) => ({ url, names }));
}

/**
 * Every `page` entry, in any section, that claims some section's landing URL.
 *
 * `buildDocsNavigation` derives a landing node for each section from the source folder's index, so
 * a `page` entry naming that same URL puts one page on two nodes while `duplicateManifestPages`
 * above stays silent: it walks `children` only and sees one claim there. The section landing is not
 * in `children` at all (FS-2749).
 *
 * **Every section's landings are checked against every section's `children`**, not each section
 * against its own. A `page` entry in Notices naming `/docs/get-started` builds the identical
 * two-node defect, and pairing each section with its own id was blind to it: measured, both static
 * rules returned empty while the transformer threw
 * `Navigation page on more than one node: /docs/get-started (Get started > (index) | Notices)`.
 *
 * The rule is exact, and needs no content tree to be exact: the landing node exists whenever
 * `/docs/<section id>` exists, because the transformer falls back from the folder's own `index` to
 * that URL. A `page` entry naming one is therefore always one node too many. The one case it judges
 * without knowing is a manifest that is already broken twice over, where the URL does not exist at
 * all: this rule runs ahead of the build, so it fires first and a contributor reads a
 * landing-flavoured message for what is really a nonexistent page. The build fails either way.
 *
 * @param {{ id?: string, children?: unknown[] }[]} sections Manifest sections.
 * @returns {{ url: string, section: string, claims: { section: string, name: string }[] }[]} One
 *   entry per over-claimed landing: the URL, the section it is the landing of, and every entry
 *   claiming it with the section that entry sits in.
 */
export function sectionLandingClaims(sections) {
  const landings = new Map();
  for (const section of sections ?? []) {
    if (typeof section?.id === 'string') landings.set(`/docs/${section.id}`, section.id);
  }

  /** @type {Map<string, { section: string, name: string }[]>} */
  const claims = new Map();
  for (const section of sections ?? []) {
    const walk = (items) => {
      for (const item of items ?? []) {
        if (typeof item?.page === 'string' && landings.has(item.page)) {
          claims.set(item.page, [
            ...(claims.get(item.page) ?? []),
            { section: section?.id ?? '(unnamed)', name: item.name ?? '(unnamed)' },
          ]);
        }
        if (Array.isArray(item?.children)) walk(item.children);
      }
    };
    walk(section?.children);
  }

  return [...landings]
    .filter(([url]) => claims.has(url))
    .map(([url, section]) => ({ url, section, claims: claims.get(url) }));
}
