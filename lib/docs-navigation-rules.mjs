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
 * Every `children` entry that claims its own section's landing URL.
 *
 * `buildDocsNavigation` derives a landing node for each section from the source folder's index, so
 * a `children` entry naming that same URL puts one page on two nodes while `duplicateManifestPages`
 * above stays silent: it walks `children` only and sees one claim there. The section landing is not
 * in `children` at all (FS-2749).
 *
 * The rule is exact, and needs no content tree to be exact. The landing node exists whenever
 * `/docs/<section id>` exists, because the transformer falls back from the folder's own `index` to
 * that URL; and if the URL does not exist, `page()` throws on the entry instead. So a `children`
 * entry naming `/docs/<section id>` is always one node too many.
 *
 * @param {{ id?: string, children?: unknown[] }[]} sections Manifest sections.
 * @returns {{ url: string, section: string, names: string[] }[]} One entry per over-claimed landing.
 */
export function sectionLandingClaims(sections) {
  const out = [];

  for (const section of sections ?? []) {
    if (typeof section?.id !== 'string') continue;
    const url = `/docs/${section.id}`;
    const names = [];
    const walk = (items) => {
      for (const item of items ?? []) {
        if (item?.page === url) names.push(item.name ?? '(unnamed)');
        if (Array.isArray(item?.children)) walk(item.children);
      }
    };
    walk(section.children);
    if (names.length > 0) out.push({ url, section: section.id, names });
  }

  return out;
}
