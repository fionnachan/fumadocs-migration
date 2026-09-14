import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Covers `getSiteUrl()` in lib/shared.ts, whose whole job is to fail loudly.
 *
 * `NEXT_PUBLIC_SITE_URL` is inlined at build time, so a production build without it would bake
 * `http://localhost:3000` into every canonical and social image URL in the deployed output. That
 * failure is invisible on the running site and only visible to crawlers, so the helper throws
 * instead, and this test is what keeps the throw from being softened into a fallback later.
 *
 * The helper lives in TypeScript, which `node --test` cannot import directly, so each case runs in
 * a subprocess with `--experimental-strip-types` and a controlled environment. That also gives us
 * the real module-load behaviour rather than a re-implementation of it.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Type stripping arrived in Node 22.6 and `engines` allows any 22.x, so on an older 22 these cases
 * skip with a reason rather than failing for an unrelated cause. CI pins `node-version: 22`, which
 * resolves to the latest 22.x, so they do run there.
 */
const stripTypes = (() => {
  try {
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', 'void 0'],
      { stdio: 'ignore' },
    );
    return false;
  } catch {
    return 'node --experimental-strip-types is unavailable on this Node build';
  }
})();

function callGetSiteUrl(env) {
  const script = `
    const { getSiteUrl } = await import(${JSON.stringify(path.join(repoRoot, 'lib/shared.ts'))});
    process.stdout.write(getSiteUrl());
  `;

  return execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      // A bare object, not a spread of process.env, so a NEXT_PUBLIC_SITE_URL that happens to be
      // exported in the developer's shell cannot mask a failure here.
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

test('getSiteUrl returns the configured site URL', { skip: stripTypes }, () => {
  assert.equal(
    callGetSiteUrl({ NEXT_PUBLIC_SITE_URL: 'https://docs.example.com' }),
    'https://docs.example.com',
  );
});

test(
  'getSiteUrl prefers the configured URL even in a production deployment',
  { skip: stripTypes },
  () => {
    assert.equal(
      callGetSiteUrl({
        NEXT_PUBLIC_SITE_URL: 'https://docs.example.com',
        VERCEL_ENV: 'production',
      }),
      'https://docs.example.com',
    );
  },
);

test(
  'getSiteUrl falls back to localhost when unset outside production',
  { skip: stripTypes },
  () => {
    assert.equal(callGetSiteUrl({}), 'http://localhost:3000');
    assert.equal(callGetSiteUrl({ VERCEL_ENV: 'preview' }), 'http://localhost:3000');
    assert.equal(
      callGetSiteUrl({ NEXT_PUBLIC_VERCEL_ENV: 'development' }),
      'http://localhost:3000',
    );
  },
);

test('getSiteUrl throws when unset in a production build', { skip: stripTypes }, () => {
  assert.throws(
    () => callGetSiteUrl({ VERCEL_ENV: 'production' }),
    /NEXT_PUBLIC_SITE_URL is not set in a production build/,
  );
});

test(
  'getSiteUrl also throws on the build-inlined production flag alone',
  { skip: stripTypes },
  () => {
    assert.throws(
      () => callGetSiteUrl({ NEXT_PUBLIC_VERCEL_ENV: 'production' }),
      /NEXT_PUBLIC_SITE_URL is not set in a production build/,
    );
  },
);

test('getSiteUrl treats an empty string as unset', { skip: stripTypes }, () => {
  assert.throws(
    () => callGetSiteUrl({ NEXT_PUBLIC_SITE_URL: '', VERCEL_ENV: 'production' }),
    /NEXT_PUBLIC_SITE_URL is not set in a production build/,
  );
});
