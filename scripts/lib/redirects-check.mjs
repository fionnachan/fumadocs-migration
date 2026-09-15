/**
 * Pure argument-parsing helpers for redirects-check.mjs, split out so they can be unit tested
 * without importing the CLI script itself — that script runs a real network fetch unconditionally
 * at import time, which a test must never trigger as a side effect.
 */

/**
 * Reads `--flag <value>`, requiring a non-empty value when the flag is present at all. A value
 * that is missing (trailing flag) or itself looks like another flag (`--flag --other-flag`) is
 * treated the same way — both mean the intended value never arrived.
 */
function readFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`redirects-check: ${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv, { defaultBaseUrl } = {}) {
  const baseUrl = readFlagValue(argv, '--base-url') ?? defaultBaseUrl;
  return { baseUrl: baseUrl.replace(/\/+$/, '') };
}
