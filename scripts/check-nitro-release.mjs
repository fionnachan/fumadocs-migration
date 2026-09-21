/**
 * check-nitro-release — bump the pinned Nitro version in content/vars.json.
 *
 * Usage:
 *   pnpm nitro:check-release
 *
 * Reads the latest published Nitro release, and if it is newer than the pinned
 * `nitroVersionTag`, updates the release values in content/vars.json:
 *
 *   nitroVersionTag       the git tag, which also drives the precompile source links
 *   latestNitroNodeImage  the published node Docker image, read from Docker Hub
 *   goEthereumCommit     the go-ethereum submodule commit at nitroVersionTag
 *
 * The submodule pin is also repaired when Nitro is already current, so a stale or missing
 * goEthereumCommit does not have to wait for another release. Resolve all pins before writing.
 *
 * It then rewrites hardcoded copies of the **outgoing** image tag, but only in the files that opt in
 * with a `sync-with-var: latestNitroNodeImage` marker. Those copies exist because `<Var>` does not
 * evaluate inside a code fence (content-lint rule A6), so a copy-pasteable `docker run` command has
 * to spell the tag out. See scripts/lib/nitro-node-image.mjs for why matching the outgoing value is
 * not safe on its own: the ArbOS release notes pin the same string as a fact about the past.
 *
 * Callers must regenerate the precompile tables afterwards — their implementation links
 * embed `nitroVersionTag`, so a bump leaves them stale. `.github/workflows/upstream-refresh.yml`
 * runs `precompiles:generate` in the same job for exactly this reason.
 *
 * Slimmed from arbitrum-docs `scripts/check-releases.ts`, which also maintains a
 * dependencies.json ledger for four other repositories. Nothing in this repo reads those
 * entries — they exist upstream so a commit message can tell a human "a new SDK shipped".
 */
import fs from 'node:fs';
import path from 'node:path';

import { runScript, setOutput, writeOrCheck } from './lib/generated-partial.mjs';
import { syncImageInContent } from './lib/nitro-node-image.mjs';

const VARS_PATH = path.join('content', 'vars.json');
const NITRO_REPO = 'OffchainLabs/nitro';

function githubHeaders() {
  const headers = { 'User-Agent': 'fumadocs-docs-bot', 'Accept': 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function githubJson(endpoint) {
  const response = await fetch(`https://api.github.com/repos/${NITRO_REPO}/${endpoint}`, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${endpoint} failed with status ${response.status}`);
  }
  return response.json();
}

/**
 * Compare `vX.Y.Z` tags numerically. `releases/latest` already excludes prereleases, so a
 * three-part compare is enough and avoids taking on a semver dependency. Returns true when
 * `candidate` is strictly newer, so a deleted release can never trigger a downgrade.
 */
function isNewer(candidate, current) {
  const parse = (tag) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const [next, base] = [parse(candidate), parse(current)];
  if (!next || !base) throw new Error(`Cannot compare versions "${candidate}" and "${current}"`);

  for (let i = 0; i < 3; i++) {
    if (next[i] !== base[i]) return next[i] > base[i];
  }
  return false;
}

/**
 * The published node image for a release, read from Docker Hub.
 *
 * Deliberately NOT derived from the git tag's commit sha, which is what arbitrum-docs'
 * check-releases.ts does. That approach is unsound: `v3.11.3` is a lightweight tag on
 * commit 4130f4c, but the published image is `v3.11.3-beb2108`, and
 * `offchainlabs/nitro-node:v3.11.3-4130f4c` returns 404 on Docker Hub. The image tag tracks
 * whichever commit the release pipeline built, so the registry is the only authority.
 *
 * Matches `<tag>-<7 hex>` exactly, excluding the -arm64/-amd64/-slim/-validator/-dev/
 * -stripped variants of the same build.
 */
async function resolvePublishedNodeImage(tag) {
  const url = `https://hub.docker.com/v2/repositories/offchainlabs/nitro-node/tags?name=${tag}&page_size=100`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Docker Hub tag lookup failed with status ${response.status}`);
  }

  const { results = [] } = await response.json();
  const exact = new RegExp(`^${tag.replace(/[.]/g, '\\.')}-[0-9a-f]{7}$`);
  const matches = results
    .filter((result) => exact.test(result.name))
    .sort((a, b) => String(b.last_updated).localeCompare(String(a.last_updated)));

  if (matches.length === 0) {
    throw new Error(
      `No published offchainlabs/nitro-node image for ${tag}. The release may predate its ` +
        `image build — rerun once the image is pushed.`,
    );
  }
  if (matches.length > 1) {
    console.warn(`warning: ${matches.length} images match ${tag}; using the newest.`);
  }

  return `offchainlabs/nitro-node:${matches[0].name}`;
}

async function main() {
  const vars = JSON.parse(fs.readFileSync(VARS_PATH, 'utf-8'));
  const release = await githubJson('releases/latest');
  const latest = release.tag_name;

  console.log(`pinned:  ${vars.nitroVersionTag}`);
  console.log(`latest:  ${latest} (published ${release.published_at?.slice(0, 10) ?? 'unknown'})`);

  const bumpRelease = isNewer(latest, vars.nitroVersionTag);
  const targetTag = bumpRelease ? latest : vars.nitroVersionTag;
  const submodule = await githubJson(`contents/go-ethereum?ref=${encodeURIComponent(targetTag)}`);
  if (
    submodule.type !== 'submodule' ||
    submodule.submodule_git_url !== 'https://github.com/OffchainLabs/go-ethereum.git' ||
    !/^[0-9a-f]{40}$/.test(submodule.sha ?? '')
  ) {
    throw new Error(`Invalid go-ethereum submodule at Nitro ${targetTag}`);
  }

  if (!bumpRelease && vars.goEthereumCommit === submodule.sha) {
    console.log('nitro and go-ethereum pins are up to date.');
    setOutput('updates_made', 'false');
    return;
  }

  const updated = {
    ...vars,
    nitroVersionTag: targetTag,
    latestNitroNodeImage: bumpRelease
      ? await resolvePublishedNodeImage(targetTag)
      : vars.latestNitroNodeImage,
    goEthereumCommit: submodule.sha,
  };

  await writeOrCheck(VARS_PATH, JSON.stringify(updated, null, 2), { check: false });

  console.log(`updated nitroVersionTag      → ${updated.nitroVersionTag}`);
  console.log(`updated latestNitroNodeImage → ${updated.latestNitroNodeImage}`);
  console.log(`updated goEthereumCommit    → ${updated.goEthereumCommit}`);

  // A `docker run` line a reader copies has to carry the image tag literally, because `<Var>` does
  // not evaluate inside a code fence (content-lint A6). Those copies would otherwise keep the old
  // tag while the prose beside them advertises the new one, with no gate to catch it. Only files
  // that opted in are rewritten; a page stating a Nitro version historically carries no marker.
  const synced = syncImageInContent(
    process.cwd(),
    vars.latestNitroNodeImage,
    updated.latestNitroNodeImage,
  );
  const total = synced.reduce((n, f) => n + f.count, 0);
  console.log(
    total === 0
      ? 'no hardcoded copies of the old image in content/'
      : `rewrote ${total} hardcoded copies of the old image across ${synced.length} file(s):`,
  );
  for (const f of synced) console.log(`  ${f.rel} (${f.count})`);

  console.log('Regenerate the precompile tables: pnpm precompiles:generate');

  setOutput('updates_made', 'true');
  setOutput('updated_version', targetTag);
}

runScript(main);
