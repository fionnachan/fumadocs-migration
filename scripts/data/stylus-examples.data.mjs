/**
 * Inputs for `generate-stylus-examples.mjs`: which pages of `offchainlabs/stylus-by-example`
 * this site publishes, in what order, and the frontmatter fields the source cannot supply.
 *
 * Ported from the `allowLists` and `output.sections` blocks of arbitrum-docs
 * `scripts/sync-stylus-content.js`.
 */

/** The upstream repository. Cloned shallow, at its default branch, on every run. */
export const repoUrl = 'https://github.com/offchainlabs/stylus-by-example.git';

/** Where the Next.js app router pages live inside that clone. */
export const sourceRoot = 'src/app';

/** Where the generated pages land, and the URL prefix the same pages serve at. */
export const outputDir = 'content/docs/stylus/stylus-by-example';
export const outputUrl = '/docs/stylus/stylus-by-example';

/**
 * The partial spliced in ahead of the first Rust snippet on every page.
 *
 * Root-anchored rather than file-relative: these are doc pages, and a root-anchored
 * `<include cwd>` survives the page being moved (see the partials section of CLAUDE.md).
 */
export const notForProductionInclude =
  '<include cwd>content/partials/_not-for-production-banner-partial.mdx</include>';

/**
 * The frontmatter this repo requires and `page.mdx` has no way to express. Upstream carries only
 * `title` and `description`, as a Next.js `metadata` export; the other three fields are this
 * site's page contract (see `source.config.ts`), so they are constants rather than anything read
 * from the source. Every ported page is a worked example, hence `concept` throughout.
 */
export const frontmatterDefaults = {
  content_type: 'concept',
  author: 'gblanchemain',
  sme: 'gblanchemain',
};

/**
 * The published set, one entry per directory under `outputDir`.
 *
 * `pages` is an allowlist and doubles as the `meta.json` order, which is why it is alphabetical
 * here and not in upstream's sidebar order: the committed `meta.json` files are alphabetical, and
 * the generator has to reproduce them rather than reorder the sidebar. Upstream publishes far
 * more examples than these; the generator reports the ones it skipped on every run, so a new
 * upstream page shows up in the weekly refresh log instead of vanishing silently. Adding one here
 * is a deliberate act — it is a new page on this site.
 */
export const sections = [
  {
    dir: 'basic_examples',
    title: 'Basic_examples',
    pages: [
      'abi_decode',
      'abi_encode',
      'bytes_in_bytes_out',
      'constants',
      'errors',
      'events',
      'function',
      'function_selector',
      'hashing',
      'hello_world',
      'inheritance',
      'primitive_data_types',
      'sending_ether',
      'variables',
      'vm_affordances',
    ],
  },
  {
    dir: 'applications',
    title: 'Applications',
    pages: ['erc20', 'erc721', 'multi_call', 'vending_machine'],
  },
];
