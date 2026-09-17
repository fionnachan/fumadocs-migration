import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { transformerTwoslash } from 'fumadocs-twoslash';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

// Shared by the site and check-links: anchor validation must use the same MDX transforms.
export const mdxOptions = {
  // Fumadocs-mdx already wires `remark-include` internally (verified in
  // dist/build-mdx-*.js). The `<include>` MDX directive works out of the box
  // — no additional remark plugins required for partial inclusion.
  //
  // remark-math + rehype-katex render the LaTeX math ($…$ / $$…$$) used across
  // the ported docs (mirrors the Docusaurus setup). KaTeX CSS is imported in
  // app/layout.tsx.
  remarkPlugins: [remarkMath],
  // Never reach out to the network to measure a third-party image.
  //
  // fumadocs' remark-image probes every image for its intrinsic size, and for an `https://` src
  // that means an HTTP request at compile time. `onError` defaults to `error`, so a single dead
  // URL threw and took the whole MDX compile down: every docs page 500s, not just the page
  // holding the image (FS-2681).
  //
  // `external: false` disables the probe for remote URLs only, and nothing else changes for
  // local images: `useImport` stays on, so a `/img/…` src is imported and the bundler fails the
  // build on a path that does not exist.
  //
  // The consequence to know about is that a markdown image with a remote src now reaches
  // `next/image` without a `width` and renders as an HTTP 500. That is the case
  // `pnpm images:presence` blocks in CI. `<ImageZoom src="https://…" />` is unaffected, because
  // it is a plain `<img>`. See INTERNALS.md "Remote images are never fetched at build".
  remarkImageOptions: {
    external: false,
  },
  rehypePlugins: (v) => [rehypeKatex, ...v],
  //
  // twoslash only activates on ```ts twoslash blocks (TypeScript). Other
  // languages (shell, Rust, Solidity) fall through to the default transformers.
  rehypeCodeOptions: {
    ...rehypeCodeDefaultOptions,
    transformers: [...(rehypeCodeDefaultOptions.transformers ?? []), transformerTwoslash()],
    // No `langs` preload here despite https://www.fumadocs.dev/docs/markdown/twoslash saying one is
    // needed for a fenced block quoted *inside* a twoslash hover popup: verified against this
    // fumadocs-core (rehype-code) + fumadocs-twoslash pairing that it is not. The outer block's own
    // language (`ts`/`tsx`) is already lazy-loaded before the twoslash transformer runs, and a
    // language quoted inside a JSDoc comment popup self-heals — `codeToHast` throws `ShikiError`,
    // fumadocs-twoslash catches it and queues `highlighter.loadLanguage(lang)` as a postprocess step
    // that `rehype-code` awaits before returning. Reproduced in both `pnpm dev` and a production
    // build: a `js` block and an unrelated, never-preloaded `python` block, both quoted inside a
    // twoslash popup, render fully tokenized (keyword/string colors present) with no 500 and no
    // console error. Do not re-add `langs` on the docs page's authority alone without re-testing.
  },
};
