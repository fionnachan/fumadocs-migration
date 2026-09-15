import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractRemoteImages,
  isReachable,
  stripCodeFences,
  stripInlineCode,
} from './lib/remote-images.mjs';

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

test('extractRemoteImages finds any JSX element carrying a remote src', () => {
  const source = [
    '<ImageZoom src="https://example.com/zoom.png" alt="zoom" />',
    '<ImageWithCaption src="https://example.com/caption.png" caption="c" />',
    '<Image src="https://example.com/next.png" />',
  ].join('\n');

  const found = extractRemoteImages(source);
  assert.deepEqual(
    found.map((image) => [image.element, image.syntax]),
    [
      ['ImageZoom', 'jsx'],
      ['ImageWithCaption', 'jsx'],
      ['Image', 'jsx'],
    ],
  );
});

test('extractRemoteImages ignores elements that take a src without being an image', () => {
  const source = [
    '<script src="https://cdn.example.com/lib.js"></script>',
    '<iframe src="https://example.com/embed"></iframe>',
    '<video src="https://example.com/clip.mp4" />',
  ].join('\n');

  assert.deepEqual(extractRemoteImages(source), []);
});

test('extractRemoteImages separates the syntax that 500s from the syntax that renders', () => {
  const source = [
    '![breaks the page](https://example.com/markdown.png)',
    '<ImageZoom src="https://example.com/fine.png" />',
  ].join('\n');

  const found = extractRemoteImages(source);
  assert.deepEqual(
    found.map((image) => image.syntax),
    ['markdown', 'jsx'],
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

test('stripCodeFences does not close a four-backtick fence on an inner three-backtick line', () => {
  const source = [
    '````markdown',
    '```js',
    "const url = '![x](https://example.com/inner.png)';",
    '```',
    '![still fenced](https://example.com/fenced.png)',
    '````',
    '![real](https://example.com/real.png)',
  ].join('\n');

  const found = extractRemoteImages(source);
  assert.deepEqual(
    found.map((image) => image.url),
    ['https://example.com/real.png'],
  );
  assert.equal(found[0].line, 7);
});

test('stripCodeFences does not close a backtick fence on a tilde fence', () => {
  const source = ['```', '~~~', '![fenced](https://example.com/a.png)', '```', ''].join('\n');
  assert.deepEqual(extractRemoteImages(source), []);
});

test('stripCodeFences preserves the line count', () => {
  const source = ['a', '```js', 'const x = 1;', '```', 'b'].join('\n');
  assert.equal(stripCodeFences(source).split('\n').length, source.split('\n').length);
});

test('extractRemoteImages finds every reference-style spelling of a remote image', () => {
  const source = [
    '![Full reference][shot]',
    '![collapsed][]',
    '![shortcut]',
    '',
    '[shot]: https://example.com/full.png',
    '[collapsed]: https://example.com/collapsed.png "A title"',
    '[shortcut]: <https://example.com/shortcut.png>',
  ].join('\n');

  const found = extractRemoteImages(source);
  assert.deepEqual(
    found.map((image) => [image.line, image.url, image.syntax]),
    [
      [1, 'https://example.com/full.png', 'markdown'],
      [2, 'https://example.com/collapsed.png', 'markdown'],
      [3, 'https://example.com/shortcut.png', 'markdown'],
    ],
  );
});

test('extractRemoteImages matches reference labels case-insensitively', () => {
  const source = ['![Alt][My Shot]', '', '[my   shot]: https://example.com/a.png'].join('\n');
  assert.deepEqual(
    extractRemoteImages(source).map((image) => image.url),
    ['https://example.com/a.png'],
  );
});

test('extractRemoteImages ignores reference images resolving to a local path', () => {
  const source = ['![local][a]', '', '[a]: /img/a.png'].join('\n');
  assert.deepEqual(extractRemoteImages(source), []);
});

test('extractRemoteImages ignores bracketed text with no matching definition', () => {
  assert.deepEqual(extractRemoteImages('![not an image]\n\nJust prose.\n'), []);
});

test('extractRemoteImages does not double-report an inline image as a shortcut reference', () => {
  const found = extractRemoteImages('![a diagram](https://example.com/a.png)\n');
  assert.equal(found.length, 1);
});

test('extractRemoteImages ignores images written inside an inline code span', () => {
  const source = [
    'Write it as `![alt](https://example.com/doc.png)` in your MDX.',
    'Or as `<ImageZoom src="https://example.com/jsx.png" />` for a remote host.',
    '',
    '![real](https://example.com/real.png)',
  ].join('\n');

  const found = extractRemoteImages(source);
  assert.deepEqual(
    found.map((image) => image.url),
    ['https://example.com/real.png'],
  );
  assert.equal(found[0].line, 4);
});

test('stripInlineCode leaves an unmatched backtick run as literal text', () => {
  const source = '![real](https://example.com/a.png) and a stray ` backtick';
  assert.deepEqual(
    extractRemoteImages(source).map((image) => image.url),
    ['https://example.com/a.png'],
  );
});

test('stripInlineCode closes a span only on a run of the same length', () => {
  const source = '``code with a ` tick and ![x](https://example.com/in.png)`` ok';
  assert.deepEqual(extractRemoteImages(source), []);
});

test('stripInlineCode preserves length and line count', () => {
  const source = ['a `x` b', 'c `![i](https://example.com/a.png)` d'].join('\n');
  const stripped = stripInlineCode(source);
  assert.equal(stripped.length, source.length);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
});

test('isReachable accepts 2xx and 3xx only', () => {
  assert.equal(isReachable(200), true);
  assert.equal(isReachable(302), true);
  assert.equal(isReachable(403), false);
  assert.equal(isReachable(404), false);
  assert.equal(isReachable(500), false);
  assert.equal(isReachable(undefined), false);
});
