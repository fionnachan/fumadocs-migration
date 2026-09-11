/**
 * Extract remotely hosted images from MDX source.
 *
 * "Remote" means an `http:` or `https:` src. Those are the ones that cannot render on this site:
 * markdown images go through `next/image`, and `next.config.mjs` declares no
 * `images.remotePatterns`, so the only images that work are the ones committed under `public/`.
 * `source.config.ts` stops a dead remote URL from breaking the MDX compile; this module powers the
 * report that finds them in the first place (`pnpm images:check`).
 *
 * Pure string handling, no filesystem and no network, so it is cheap to unit test.
 */

/**
 * Blank out fenced code blocks, keeping the line count intact so reported line numbers stay true.
 *
 * A URL inside a shell or JSON sample is documentation, not an image reference.
 */
export function stripCodeFences(source) {
  const lines = source.split('\n');
  let fence = null;

  return lines
    .map((line) => {
      const match = /^\s*(`{3,}|~{3,})/.exec(line);

      if (match) {
        const marker = match[1];
        if (fence === null) {
          fence = marker[0].repeat(3);
          return '';
        }
        if (marker.startsWith(fence)) {
          fence = null;
          return '';
        }
        return '';
      }

      return fence === null ? line : '';
    })
    .join('\n');
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s<>)]+)>?[^)]*\)/g;
const JSX_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["'{]\s*["']?(https?:\/\/[^"'\s{}]+)/gi;

/**
 * Every remote image in one MDX file, in source order.
 *
 * @param {string} source raw MDX
 * @returns {{ url: string, line: number, alt: string, syntax: 'markdown' | 'jsx' }[]}
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
      syntax: 'markdown',
    });
  }

  for (const match of scannable.matchAll(JSX_IMAGE)) {
    found.push({
      url: match[1],
      line: lineOf(match.index),
      alt: '',
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
