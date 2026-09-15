/**
 * Pure argument-parsing and error-message helpers for redirects-check.mjs, split out so they can
 * be unit tested without importing the CLI script itself — that script runs a real network fetch
 * unconditionally at import time, which a test must never trigger as a side effect.
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

export function parseArgs(argv, { defaultBaseUrl, env = process.env } = {}) {
  const baseUrl = readFlagValue(argv, '--base-url') ?? defaultBaseUrl;
  const bypassHeader =
    readFlagValue(argv, '--bypass-header') ?? env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '';
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    bypassHeader,
  };
}

/** The hint appended to a fetch failure, only useful when the response looks protection-gated. */
export function protectionHint(status) {
  return status === 401 || status === 403
    ? ' — if this deployment has Vercel Deployment Protection enabled, pass ' +
        '--bypass-header <secret> or set VERCEL_AUTOMATION_BYPASS_SECRET'
    : '';
}
