/**
 * Extract remotely hosted images from MDX source.
 *
 * "Remote" means an `http:` or `https:` src. The two syntaxes behave very differently once the page
 * renders, which is why every result carries its `syntax`:
 *
 *   - **markdown** (`![alt](https://…)`) resolves to `next/image`. With
 *     `remarkImageOptions.external: false` in `source.config.ts` nothing measures the image at
 *     build, so the component receives no `width`, and Next throws
 *     `Image with src "…" is missing required "width" property`. The page 500s. These must not
 *     reach `main`, which is what `--presence` guards.
 *   - **jsx** (`<ImageZoom src="https://…">`) resolves to `components/mdx/ImageZoom`, a plain
 *     `<img>`. A remote src renders fine. It can still rot, which is what the network mode reports.
 *
 * Pure string handling, no filesystem and no network, so it is cheap to unit test.
 */

/**
 * Blank out fenced code blocks, keeping the line count intact so reported line numbers stay true.
 *
 * A URL inside a shell or HTML sample is documentation, not an image reference. The opening fence's
 * own length is remembered, because CommonMark closes a fence only on a run of the same character
 * that is at least as long: a ```` ```` ```` block may contain ``` ``` ``` lines, and treating one
 * of those as the close would expose the rest of the sample to the scanners.
 */
export function stripCodeFences(source) {
  /** @type {{ char: string, length: number } | null} */
  let fence = null;

  return source
    .split('\n')
    .map((line) => {
      const match = /^\s*(`{3,}|~{3,})/.exec(line);

      if (!match) return fence === null ? line : '';

      const marker = match[1];

      if (fence === null) {
        fence = { char: marker[0], length: marker.length };
      } else if (marker[0] === fence.char && marker.length >= fence.length) {
        fence = null;
      }

      return '';
    })
    .join('\n');
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s<>)]+)>?[^)]*\)/g;

/**
 * Any JSX element carrying a remote `src`, so an image alias nobody told this script about is still
 * found. `components/mdx.tsx` is the registry, and it grows: `ImageZoom`, `ImageWithCaption` and
 * whatever gets added next all take `src`.
 */
const JSX_SRC = /<([A-Za-z][\w.]*)\b[^>]*?\bsrc\s*=\s*["'{]\s*["']?(https?:\/\/[^"'\s{}]+)/g;

/**
 * Elements that take a `src` without being an image. They rot too, but they are not this script's
 * business and reporting them as images would be wrong.
 */
const NOT_IMAGES = new Set(['script', 'iframe', 'video', 'audio', 'source', 'track', 'embed']);

/**
 * Every remote image in one MDX file, in source order.
 *
 * @param {string} source raw MDX
 * @returns {{ url: string, line: number, alt: string, element: string, syntax: 'markdown' | 'jsx' }[]}
 */
export function extractRemoteImages(source) {
  const scannable = stripCodeFences(source);
  const found = [];

  const lineOf = (index) => scannable.slice(0, index).split('\n').length;

  for (const match of scannable.matchAll(MARKDOWN_IMAGE)) {
    found.push({
      url: match[2],
      line: lineOf(match.index),
      alt: match[1],
      element: 'markdown',
      syntax: 'markdown',
    });
  }

  for (const match of scannable.matchAll(JSX_SRC)) {
    if (NOT_IMAGES.has(match[1].toLowerCase())) continue;

    found.push({
      url: match[2],
      line: lineOf(match.index),
      alt: '',
      element: match[1],
      syntax: 'jsx',
    });
  }

  return found.sort((a, b) => a.line - b.line || a.url.localeCompare(b.url));
}

/**
 * Decide whether a probe result counts as reachable.
 *
 * Redirects count: image hosts routinely 302 to a CDN or a signed URL.
 */
export function isReachable(status) {
  return typeof status === 'number' && status >= 200 && status < 400;
}
