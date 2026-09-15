import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArgs, protectionHint } from './lib/redirects-check.mjs';

const defaults = { defaultBaseUrl: 'http://localhost:3000', env: {} };

test('parseArgs falls back to the default base URL and an empty bypass header', () => {
  const result = parseArgs([], defaults);
  assert.equal(result.baseUrl, 'http://localhost:3000');
  assert.equal(result.bypassHeader, '');
});

test('parseArgs reads --base-url and strips a trailing slash', () => {
  const result = parseArgs(['--base-url', 'https://preview.example.com/'], defaults);
  assert.equal(result.baseUrl, 'https://preview.example.com');
});

test('parseArgs: --bypass-header beats the environment variable', () => {
  const result = parseArgs(['--bypass-header', 'flag-secret'], {
    ...defaults,
    env: { VERCEL_AUTOMATION_BYPASS_SECRET: 'env-secret' },
  });
  assert.equal(result.bypassHeader, 'flag-secret');
});

test('parseArgs: the environment variable applies when the flag is absent', () => {
  const result = parseArgs([], { ...defaults, env: { VERCEL_AUTOMATION_BYPASS_SECRET: 'env-secret' } });
  assert.equal(result.bypassHeader, 'env-secret');
});

test('parseArgs rejects --base-url with no value instead of throwing on .replace later', () => {
  assert.throws(() => parseArgs(['--base-url'], defaults), /--base-url requires a value/);
});

test('parseArgs rejects a trailing --bypass-header instead of silently dropping the header', () => {
  assert.throws(() => parseArgs(['--bypass-header'], defaults), /--bypass-header requires a value/);
});

test('parseArgs rejects --bypass-header immediately followed by another flag', () => {
  assert.throws(
    () => parseArgs(['--bypass-header', '--base-url', 'https://preview.example.com'], defaults),
    /--bypass-header requires a value/,
  );
});

test('protectionHint names the flag and env var for 401 and 403, and is empty otherwise', () => {
  assert.match(protectionHint(401), /--bypass-header/);
  assert.match(protectionHint(401), /VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.match(protectionHint(403), /--bypass-header/);
  assert.equal(protectionHint(404), '');
  assert.equal(protectionHint(500), '');
});
