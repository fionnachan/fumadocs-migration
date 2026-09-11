/**
 * upstream-tree — locate the upstream Docusaurus checkout (OffchainLabs/arbitrum-docs).
 *
 * `scripts/data/upstream.config.json` has always described this resolution order, but nothing read
 * the file: `upstream-drift.mjs` carried a hardcoded absolute path to one contributor's machine and
 * fell back to it whenever `--tree-a` was absent, so `pnpm drift` failed on every other checkout.
 * This module is the implementation the config's `$comment` promised.
 *
 * Resolution order, first hit wins:
 *   1. `--tree-a <path>`       the docs tree itself, resolved against the cwd (a shell argument)
 *   2. `UPSTREAM_DOCS_REPO`    the repo root, resolved against the cwd
 *   3. `repo` in the config    the repo root, resolved against THIS repo's root
 *   4. `probePaths`            repo roots, resolved against THIS repo's root, tried in order
 *
 * Config paths resolve against the repo root rather than the cwd because the checkout's position
 * relative to this repo is fixed while the cwd is not: the sibling clone sits at `../arbitrum-docs`
 * from the main checkout and at `../../arbitrum-docs` from a worktree under `../Fumadocs-wt/`, and
 * both are listed in `probePaths`. A leading `~` is expanded.
 *
 * Every source except `--tree-a` names the repo root, so `docsSubdir` ("docs") is appended to it.
 * `--tree-a` names the docs tree directly, matching how the flag has always been documented.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: this file is at `<root>/scripts/lib/upstream-tree.mjs`. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_PATH = path.join(repoRoot, 'scripts', 'data', 'upstream.config.json');

/** Expand a leading `~` so `probePaths` can name a home-relative checkout. */
export function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

export function readUpstreamConfig(configPath = CONFIG_PATH) {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

/**
 * Pick the upstream docs tree.
 *
 * Pure apart from the injected `exists` probe, so the resolution order is testable without a
 * second checkout on disk.
 *
 * @param {object} options
 * @param {string[]} [options.argv] Raw CLI arguments (the `--tree-a <path>` pair is read from here).
 * @param {Record<string,string|undefined>} [options.env] Environment, read for `UPSTREAM_DOCS_REPO`.
 * @param {object} [options.config] Parsed `upstream.config.json`.
 * @param {string} [options.root] Root that config-relative paths resolve against.
 * @param {string} [options.cwd] Directory that CLI- and env-relative paths resolve against.
 * @param {(p: string) => boolean} [options.exists] Existence probe, injected for tests.
 * @param {string} [options.home] Home directory used to expand a leading `~`.
 * @returns {{docs: string, repo: string, source: string}|null} Absolute paths, or null when nothing resolved.
 */
export function resolveUpstreamTree({
  argv = [],
  env = process.env,
  config = readUpstreamConfig(),
  root = repoRoot,
  cwd = process.cwd(),
  exists = existsSync,
  home = os.homedir(),
} = {}) {
  const docsSubdir = config.docsSubdir ?? 'docs';

  /** A candidate that names the docs tree directly: the repo is its parent. */
  const fromDocs = (value, base, source) => {
    const docs = path.resolve(base, expandHome(value, home));
    return { docs, repo: path.dirname(docs), source };
  };

  /** A candidate that names the repo root: the docs tree is `docsSubdir` inside it. */
  const fromRepo = (value, base, source) => {
    const repo = path.resolve(base, expandHome(value, home));
    return { docs: path.join(repo, docsSubdir), repo, source };
  };

  const candidates = [];

  const flagIndex = argv.indexOf('--tree-a');
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    candidates.push(fromDocs(argv[flagIndex + 1], cwd, '--tree-a'));
  }

  if (env.UPSTREAM_DOCS_REPO) {
    candidates.push(fromRepo(env.UPSTREAM_DOCS_REPO, cwd, 'UPSTREAM_DOCS_REPO'));
  }

  if (config.repo) {
    candidates.push(fromRepo(config.repo, root, 'config.repo'));
  }

  for (const probe of config.probePaths ?? []) {
    candidates.push(fromRepo(probe, root, `config.probePaths (${probe})`));
  }

  return candidates.find((c) => exists(c.docs)) ?? null;
}

/**
 * Upstream paths that must never be reported as ABSENT, from `absentAllowlist` in the config.
 *
 * @param {object} [config] Parsed `upstream.config.json`.
 * @returns {Set<string>} Upstream-relative paths to suppress.
 */
export function allowlistedAbsent(config = readUpstreamConfig()) {
  return new Set((config.absentAllowlist ?? []).map((entry) => entry.path));
}

/**
 * Upstream paths that must never be reported as GUTTED, from `guttedAllowlist` in the config.
 *
 * Kept separate from the absent allowlist because the two suppress different verdicts and are
 * earned differently. A page is absent-exempt when it was deliberately never ported. A page is
 * gutted-exempt when it *was* ported at content parity and only the line count disagrees, because
 * Docusaurus import lines and inline grid boilerplate do not survive the port. One list would let
 * an exemption granted for one reason quietly cover the other.
 *
 * @param {object} [config] Parsed `upstream.config.json`.
 * @returns {Set<string>} Upstream-relative paths to suppress.
 */
export function allowlistedGutted(config = readUpstreamConfig()) {
  return new Set((config.guttedAllowlist ?? []).map((entry) => entry.path));
}

/**
 * Human-readable explanation of everywhere the resolver looked, for the failure message.
 *
 * @param {object} [config] Parsed `upstream.config.json`.
 * @returns {string[]}
 */
export function describeSearchOrder(config = readUpstreamConfig()) {
  return [
    '--tree-a <path to the upstream docs tree>',
    'UPSTREAM_DOCS_REPO=<path to the upstream repo>',
    ...(config.repo ? [`repo in upstream.config.json (${config.repo})`] : []),
    ...(config.probePaths ?? []).map((p) => `probePaths entry ${p}`),
  ];
}
