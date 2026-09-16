/**
 * Turn one `offchainlabs/stylus-by-example` `page.mdx` into one page of this site.
 *
 * Everything here is a pure string transform over the source text, so the suite can pin each
 * rule to a named case instead of diffing nineteen rendered pages. The runner
 * (`scripts/generate-stylus-examples.mjs`) owns the clone, the writes and `--check`.
 *
 * Ported from the content-transformation half of arbitrum-docs `scripts/sync-stylus-content.js`.
 */

/**
 * The `export const metadata = { … };` block every upstream page opens with. Non-greedy up to the
 * first `};`, which is upstream's own rule: the object is a flat pair of string literals, and a
 * nested object would be a shape this generator has never seen and should not guess at.
 */
const METADATA_PATTERN = /export\s+const\s+metadata\s*=\s*({[\s\S]*?});/;

/** A same-directory markdown link, e.g. `[ABI Encode](./abi_encode)`. */
const RELATIVE_LINK_PATTERN = /\[([^\]]+)\]\(\.\/([\w-]+)\)/g;

/** The fence that opens the first Rust snippet, and the anchor for the banner. */
const RUST_FENCE = '```rust';

/**
 * Evaluate the metadata object literal.
 *
 * It is a JavaScript expression, not JSON — upstream wraps long descriptions across lines and
 * uses single quotes — so nothing short of evaluating it will do. The input is a file this
 * generator just cloned from a repository the docs team owns, over HTTPS, and the expression is
 * matched to start with `{`, so this is the same trust boundary as the rest of the clone.
 *
 * @param {string} source the full text of an upstream `page.mdx`
 * @param {string} context a path, for the error message
 * @returns {{ title: string, description: string }}
 */
export function parseMetadata(source, context) {
  const match = source.match(METADATA_PATTERN);
  if (!match) {
    throw new Error(`${context}: no \`export const metadata\` block; cannot build frontmatter`);
  }

  let metadata;
  try {
    metadata = new Function(`return ${match[1]}`)();
  } catch (error) {
    throw new Error(`${context}: could not evaluate the metadata object: ${error.message}`);
  }

  for (const field of ['title', 'description']) {
    if (typeof metadata[field] !== 'string' || metadata[field].trim() === '') {
      throw new Error(`${context}: metadata.${field} is missing or not a string`);
    }
  }
  return metadata;
}

/**
 * Quote a value as a single-quoted YAML scalar, doubling any apostrophe.
 *
 * Prettier re-quotes the frontmatter afterwards (a value containing an apostrophe comes out
 * double-quoted, which is what the committed pages look like), so this only has to be valid
 * YAML, not canonical YAML.
 */
export function yamlScalar(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render the frontmatter block for a page.
 *
 * `title` and `description` come from the source; the rest are constants, and are emitted
 * unquoted because that is the scalar style the committed pages use and Prettier preserves a
 * plain scalar rather than quoting it.
 *
 * @param {{ title: string, description: string }} metadata
 * @param {Record<string, string>} defaults
 */
export function renderFrontmatter(metadata, defaults) {
  return [
    '---',
    `title: ${yamlScalar(metadata.title)}`,
    `description: ${yamlScalar(metadata.description)}`,
    ...Object.entries(defaults).map(([key, value]) =>
      key === 'content_type' ? `${key}: ${yamlScalar(value)}` : `${key}: ${value}`,
    ),
    '---',
  ].join('\n');
}

/**
 * Rewrite upstream's same-directory links onto this site's URLs.
 *
 * Upstream hardcodes `/stylus-by-example/basic_examples/<slug>` as the destination, which is only
 * right because the one relative link in the published set happens to sit in `basic_examples`.
 * Resolving the slug against the published set instead gets the same answer for that link and the
 * right answer for one written from an `applications` page. A slug that resolves nowhere throws:
 * a link to an example this site does not publish would otherwise ship as a 404 that only
 * `check-links` would catch, and only after the page had been committed.
 *
 * @param {string} content
 * @param {{ sections: Array<{ dir: string, pages: string[] }>, baseUrl: string, context: string }} options
 */
export function rewriteRelativeLinks(content, { sections, baseUrl, context }) {
  return content.replace(RELATIVE_LINK_PATTERN, (match, text, slug) => {
    const owners = sections.filter((section) => section.pages.includes(slug));
    if (owners.length !== 1) {
      throw new Error(
        `${context}: the link \`${match}\` points at \`${slug}\`, which ` +
          (owners.length === 0
            ? 'this site does not publish. Add it to scripts/data/stylus-examples.data.mjs, or ' +
              'get the link changed upstream.'
            : `appears in ${owners.length} sections, so the destination is ambiguous.`),
      );
    }
    return `[${text}](${baseUrl}/${owners[0].dir}/${slug})`;
  });
}

/**
 * Splice the not-for-production banner in ahead of the first Rust snippet.
 *
 * Position is upstream's: two lines above the opening fence, so the banner lands under the
 * heading that introduces the snippet rather than between the heading and its prose. The extra
 * blank lines are deliberate — Prettier collapses them, and emitting them here means the
 * insertion cannot weld the banner onto the line above it.
 *
 * A page with no Rust snippet keeps its content and reports itself, because the banner is a
 * safety notice and silently dropping one should not look like success.
 *
 * @returns {{ content: string, inserted: boolean }}
 */
export function insertNotForProductionBanner(content, include) {
  const fence = content.indexOf(RUST_FENCE);
  if (fence === -1) return { content, inserted: false };

  const before = content.slice(0, fence).split('\n');
  before.splice(before.length - 2, 0, `\n${include}\n`);
  return { content: before.join('\n') + content.slice(fence), inserted: true };
}

/**
 * Build one page from one upstream `page.mdx`.
 *
 * @param {object} options
 * @param {string} options.source the upstream file's text
 * @param {string} options.context the upstream path, for error messages
 * @param {string} options.marker the do-not-edit comment
 * @param {Record<string, string>} options.frontmatterDefaults
 * @param {Array<{ dir: string, pages: string[] }>} options.sections
 * @param {string} options.baseUrl
 * @param {string} options.include the not-for-production `<include>` directive
 * @returns {{ content: string, metadata: object, banner: boolean }}
 */
export function buildPage({
  source,
  context,
  marker,
  frontmatterDefaults,
  sections,
  baseUrl,
  include,
}) {
  const metadata = parseMetadata(source, context);
  const frontmatter = renderFrontmatter(metadata, frontmatterDefaults);

  // Replacing the metadata export in place, rather than rebuilding the file around the body,
  // keeps everything upstream puts after it — the `{/* Begin Content */}` marker included —
  // exactly where upstream put it.
  let content = source.replace(METADATA_PATTERN, `${frontmatter}\n\n${marker}`);
  content = rewriteRelativeLinks(content, { sections, baseUrl, context });

  const banner = insertNotForProductionBanner(content, include);
  return { content: banner.content, metadata, banner: banner.inserted };
}

/**
 * The `meta.json` for one section: the sidebar title, the published pages in the order the data
 * file lists them, and the `'...'` catch-all the committed files carry so an unlisted sibling
 * still appears rather than disappearing from the sidebar.
 *
 * @param {{ title: string, pages: string[] }} section
 */
export function buildSectionMeta({ title, pages }) {
  return { title, pages: [...pages, '...'] };
}
