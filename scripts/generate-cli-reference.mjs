/**
 * generate-cli-reference: regenerate content/docs/run-a-node/nitro/cli-flags-reference.mdx.
 *
 * Usage:
 *   pnpm cli:generate                        # clone the pinned Nitro tag and write the page
 *   pnpm cli:generate --nitro-path ../nitro  # read an existing Nitro clone instead
 *   pnpm cli:check                           # exit 1 with a diff summary when the page is stale
 *
 * The flags come from the Nitro source at the tag pinned as `nitroVersionTag` in
 * content/vars.json, read straight from the Go that registers them. Two alternatives were
 * rejected:
 *
 * - Running `nitro --help`, which is what the flag list really is, needs a Go toolchain plus the
 *   Rust arbitrator artifacts. That is a heavy CI job for a documentation refresh, and it is the
 *   reason the workflow step added for this generator needs no toolchain at all.
 * - Committing a JSON dump of the flags, which is what arbitrum-docs does. Nothing regenerates
 *   that file, so it is only ever as fresh as the last person who remembered.
 *
 * `--nitro-path` still reads the tree at the pinned tag (via `git archive`), not the checkout's
 * working state, so a local run and a CI run see the same source.
 *
 * Ported from arbitrum-docs `scripts/generate-cli-reference.ts`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import prettier from 'prettier';

import {
  customFlagTypes,
  defaultNamespaceLink,
  defaultOverrides,
  entryPoint,
  exclusions,
  namespaceLinks,
} from './data/nitro-cli-reference.data.mjs';
import { renderGeneratedRegion, splicePage } from './lib/cli-reference-page.mjs';
import { StaleFileError, isCheckMode, runScript, writeOrCheck } from './lib/generated-partial.mjs';
import { indexGoTree } from './lib/go-source.mjs';
import { extractFlags } from './lib/nitro-cli-flags.mjs';

const OUTPUT_PATH = path.join('content', 'docs', 'run-a-node', 'nitro', 'cli-flags-reference.mdx');
const VARS_PATH = path.join('content', 'vars.json');
const NITRO_URL = 'https://github.com/OffchainLabs/nitro.git';

/** Go module paths of the two trees the flags live in. */
const NITRO_MODULE = 'github.com/offchainlabs/nitro';
const GETH_MODULE = 'github.com/ethereum/go-ethereum';

/** See MDX_FORMAT in generate-precompile-tables.mjs: the generator owns this file's shape. */
const MDX_FORMAT = { parser: 'mdx', printWidth: 9999, proseWrap: 'preserve', plugins: [] };

function parseArgs(argv) {
  const args = { check: isCheckMode(), nitroPath: process.env.NITRO_REPO_PATH ?? null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--nitro-path' && argv[i + 1]) args.nitroPath = argv[++i];
  }
  return args;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

/** Extract `ref`'s tree from `repo` into `dest` without touching the repo's working state. */
function extractTree(repo, ref, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const archive = execFileSync('git', ['archive', ref], {
    cwd: repo,
    maxBuffer: 512 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', dest], { input: archive, maxBuffer: 512 * 1024 * 1024 });
}

/**
 * Put the Nitro tree at `tag`, plus its pinned go-ethereum submodule, under `workDir`.
 *
 * go-ethereum is not optional: Nitro registers the whole `execution.rpc.*` namespace by calling
 * into go-ethereum's `arbitrum` package, so without the submodule those flags vanish from the
 * page with no error.
 */
function materializeNitro({ tag, nitroPath, workDir }) {
  const treeDir = path.join(workDir, 'nitro');

  if (nitroPath) {
    const repo = path.resolve(nitroPath);
    try {
      git(['rev-parse', '--verify', `${tag}^{commit}`], repo);
    } catch {
      throw new Error(
        `${repo} has no tag ${tag}. Run \`git -C ${repo} fetch --tags\`, or drop ` +
          `--nitro-path to clone the tag instead.`,
      );
    }
    extractTree(repo, tag, treeDir);

    const gitlink = git(['ls-tree', tag, 'go-ethereum'], repo).trim();
    const sha = /^\d+\s+commit\s+([0-9a-f]{40})/.exec(gitlink)?.[1];
    if (!sha) throw new Error(`cannot read the go-ethereum submodule pin of ${tag} in ${repo}`);
    const gethRepo = path.join(repo, 'go-ethereum');
    try {
      git(['cat-file', '-e', `${sha}^{commit}`], gethRepo);
    } catch {
      throw new Error(
        `${gethRepo} does not have commit ${sha}, the go-ethereum pin of ${tag}. Run ` +
          `\`git -C ${gethRepo} fetch\`, or drop --nitro-path to clone the tag instead.`,
      );
    }
    extractTree(gethRepo, sha, path.join(treeDir, 'go-ethereum'));
  } else {
    console.log(`cloning ${NITRO_URL} at ${tag} (shallow)`);
    git(['clone', '--depth', '1', '--branch', tag, '--quiet', NITRO_URL, treeDir]);
    git(['submodule', 'update', '--init', '--depth', '1', '--quiet', 'go-ethereum'], treeDir);
  }

  if (!fs.existsSync(path.join(treeDir, 'go-ethereum', 'arbitrum'))) {
    throw new Error(
      `the go-ethereum submodule is missing from the extracted ${tag} tree; the ` +
        `execution.rpc.* flags are registered there and would be silently dropped`,
    );
  }
  return treeDir;
}

async function diffSummary(filePath, content) {
  const config = await prettier.resolveConfig(filePath);
  const expected = await prettier.format(content, { ...config, filepath: filePath, ...MDX_FORMAT });
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';

  const currentLines = current.split('\n');
  const expectedLines = expected.split('\n');
  let changed = 0;
  const sample = [];
  for (let i = 0; i < Math.max(currentLines.length, expectedLines.length); i++) {
    if (currentLines[i] === expectedLines[i]) continue;
    changed++;
    if (sample.length >= 40) continue;
    if (currentLines[i] !== undefined) sample.push(`  - ${currentLines[i]}`);
    if (expectedLines[i] !== undefined) sample.push(`  + ${expectedLines[i]}`);
  }
  return [`${changed} line(s) differ (- committed, + generated); first 20 shown:`, ...sample].join(
    '\n',
  );
}

async function main() {
  const { check, nitroPath } = parseArgs(process.argv.slice(2));
  const vars = JSON.parse(fs.readFileSync(VARS_PATH, 'utf-8'));
  const tag = vars.nitroVersionTag;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-cli-'));
  let content;
  try {
    const treeDir = materializeNitro({ tag, nitroPath, workDir });

    const { dirs, fileImports } = indexGoTree([
      { modulePath: NITRO_MODULE, dir: '', absDir: treeDir },
      {
        modulePath: GETH_MODULE,
        dir: 'go-ethereum',
        absDir: path.join(treeDir, 'go-ethereum'),
      },
    ]);

    const { flags, problems } = extractFlags({
      dirs,
      fileImports,
      entryPoint,
      customTypes: customFlagTypes,
      defaultOverrides,
    });
    if (problems.length > 0) {
      throw new Error(
        `generate-cli-reference: ${problems.length} flag(s) could not be read from Nitro ${tag}.\n` +
          problems.map((p) => `  - ${p}`).join('\n'),
      );
    }
    if (flags.length === 0) {
      throw new Error(
        `generate-cli-reference: no flags found in Nitro ${tag}; the walk entry ` +
          `point ${entryPoint.dir}.${entryPoint.func} has probably moved`,
      );
    }

    const published = flags.filter((flag) => !exclusions.some((rule) => rule.matches(flag)));
    const generated = renderGeneratedRegion(published, {
      namespaceLinks,
      defaultNamespaceLink,
      nitroVersionTag: tag,
    });
    const existing = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf-8') : '';
    content = splicePage(existing, generated);

    console.log(
      `nitro ${tag}: ${flags.length} flag(s) read, ` +
        `${flags.length - published.length} excluded, ${published.length} published.`,
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  try {
    await writeOrCheck(OUTPUT_PATH, content, { check, overrides: MDX_FORMAT });
  } catch (error) {
    if (error instanceof StaleFileError) console.error(await diffSummary(OUTPUT_PATH, content));
    throw error;
  }

  console.log(check ? 'cli flags reference: up to date.' : 'cli flags reference: written.');
}

runScript(main);
