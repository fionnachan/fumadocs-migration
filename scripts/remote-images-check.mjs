/**
 * remote-images-check — report images that are loaded from somebody else's server.
 *
 * Two things make a remote image a problem here:
 *
 *   1. It cannot render. Markdown images resolve to `next/image`, and `next.config.mjs` sets no
 *      `images.remotePatterns`, so a remote src is rejected at render time.
 *   2. It rots. The host can 404, geo-block, or hotlink-block us at any time, and nobody notices
 *      because no gate looks at third-party URLs.
 *
 * `source.config.ts` sets `remarkImageOptions.external: false`, so a dead URL can no longer break
 * the MDX compile (FS-2681). That removed the only feedback we had. This script is the replacement:
 * copy the image into `public/img/` and reference it as `/img/…`, or drop it.
 *
 * Reports only. It is deliberately not wired into CI, because a third party's outage is not a
 * reason to fail somebody else's pull request.
 *
 * Usage:
 *   pnpm images:check              # human report, always exits 0
 *   pnpm images:check --strict     # exits 1 if any remote image is unreachable
 *   pnpm images:check --json       # machine-readable, exits 0
 */
import fs from 'node:fs';
import path from 'node:path';

import { extractRemoteImages, isReachable } from './lib/remote-images.mjs';

const CONTENT_DIRS = ['content/docs', 'content/partials', 'content/glossary', 'content/_versions'];
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;

/** A user agent that looks like a browser: several image hosts serve 403 to anything else. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function walk(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.mdx') ? [full] : [];
  });
}

function collect(root) {
  const byFile = new Map();

  for (const dir of CONTENT_DIRS) {
    for (const file of walk(path.join(root, dir))) {
      const images = extractRemoteImages(fs.readFileSync(file, 'utf8'));
      if (images.length > 0) byFile.set(path.relative(root, file), images);
    }
  }

  return byFile;
}

/**
 * HEAD the URL, falling back to GET when the host refuses HEAD.
 *
 * Returns `{ status }` on any HTTP answer and `{ error }` when the request never completed.
 */
async function probe(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const response = await fetch(url, {
        method,
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, 'accept': 'image/*,*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // A HEAD that is refused or unimplemented says nothing about the image itself.
      if (method === 'HEAD' && [403, 405, 501].includes(response.status)) continue;
      return { status: response.status };
    } catch (error) {
      if (method === 'GET') return { error: error.message ?? String(error) };
    }
  }

  return { error: 'no response' };
}

async function probeAll(urls) {
  const results = new Map();
  const queue = [...urls];

  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      results.set(url, await probe(url));
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return results;
}

function describe(result) {
  return result.error ? `request failed: ${result.error}` : `HTTP ${result.status}`;
}

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const json = args.includes('--json');
  const root = process.cwd();

  const byFile = collect(root);
  const urls = [...new Set([...byFile.values()].flat().map((image) => image.url))];

  if (urls.length === 0) {
    if (json) console.log(JSON.stringify({ images: 0, unreachable: [] }));
    else console.log('remote-images-check: no remote images in content. Nothing to rot.');
    return;
  }

  const results = await probeAll(urls);
  const unreachable = [];

  for (const [file, images] of byFile) {
    for (const image of images) {
      const result = results.get(image.url);
      if (!isReachable(result.status)) {
        unreachable.push({ file, line: image.line, url: image.url, reason: describe(result) });
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ images: urls.length, unreachable }, null, 2));
    return;
  }

  console.log(
    `remote-images-check: ${urls.length} remote image URL(s) across ${byFile.size} file(s).`,
  );
  console.log(
    'Remote images do not render on this site (no images.remotePatterns). Copy them into public/img/.',
  );

  if (unreachable.length === 0) {
    console.log('All of them answered. None is unreachable.');
  } else {
    console.log(`\n${unreachable.length} unreachable:`);
    let current = null;
    for (const entry of unreachable) {
      if (entry.file !== current) {
        current = entry.file;
        console.log(`  ${current}`);
      }
      console.log(`    line ${entry.line}: ${entry.reason}`);
      console.log(`      ${entry.url}`);
    }
  }

  if (strict && unreachable.length > 0) process.exitCode = 1;
}

await main();
