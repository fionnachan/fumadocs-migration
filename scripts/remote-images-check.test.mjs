import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractRemoteImages, isReachable, stripCodeFences } from './lib/remote-images.mjs';

test('extractRemoteImages finds markdown images with a remote src', () => {
  const found = extractRemoteImages('![a diagram](https://example.com/a.png)\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'https://example.com/a.png');
  assert.equal(found[0].alt, 'a diagram');
  assert.equal(found[0].syntax, 'markdown');
  assert.equal(found[0].line, 1);
});

test('extractRemoteImages ignores images served from public/', () => {
  const source = ['![local](/img/a.png)', '![relative](./b.png)'].join('\n');
  assert.deepEqual(extractRemoteImages(source), []);
});

test('extractRemoteImages handles an image wrapped in a link, a title, and angle brackets', () => {
  const source = [
    '[![arch](https://example.com/arch.png)](https://example.com/)',
    '![titled](https://example.com/t.png "A title")',
    '![angled](<https://example.com/angled.png>)',
  ].join('\n');

  assert.deepEqual(
    extractRemoteImages(source).map((image) => image.url),
    ['https://example.com/arch.png', 'https://example.com/t.png', 'https://example.com/angled.png'],
  );
});

test('extractRemoteImages finds JSX img tags in either quote style', () => {
  const source = [
    '<img src="https://example.com/one.png" alt="one" />',
    "<img alt='two' src='https://example.com/two.png' />",
  ].join('\n');

  const found = extractRemoteImages(source);
  assert.deepEqual(
    found.map((image) => image.url),
    ['https://example.com/one.png', 'https://example.com/two.png'],
  );
  assert.equal(found[0].syntax, 'jsx');
});

test('extractRemoteImages skips fenced code blocks and reports true line numbers', () => {
  const source = [
    'Intro paragraph.',
    '',
    '```markdown',
    '![sample](https://example.com/in-a-fence.png)',
    '```',
    '',
    '![real](https://example.com/real.png)',
  ].join('\n');

  const found = extractRemoteImages(source);
  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'https://example.com/real.png');
  assert.equal(found[0].line, 7);
});

test('stripCodeFences preserves the line count', () => {
  const source = ['a', '```js', 'const x = 1;', '```', 'b'].join('\n');
  assert.equal(stripCodeFences(source).split('\n').length, source.split('\n').length);
});

test('isReachable accepts 2xx and 3xx only', () => {
  assert.equal(isReachable(200), true);
  assert.equal(isReachable(302), true);
  assert.equal(isReachable(403), false);
  assert.equal(isReachable(404), false);
  assert.equal(isReachable(500), false);
  assert.equal(isReachable(undefined), false);
});
