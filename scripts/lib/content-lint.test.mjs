import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { extractLocalImageSrcs, lintContent, lintSource, stripCode } from './content-lint.mjs';

const rules = (src) => lintSource(src).map((f) => f.rule);

test('stripCode blanks fenced blocks but preserves line count', () => {
  const src = 'a\n```js\n:::note\n```\nb';
  const out = stripCode(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(!out.includes(':::note'));
  assert.ok(out.startsWith('a\n'));
});

test('stripCode blanks inline code', () => {
  assert.ok(!stripCode('use `:::note` here').includes(':::note'));
});

test('A1 fires on an empty admonition body', () => {
  assert.deepEqual(
    rules('<VanillaAdmonition type="warning" title="Long stranded prose"></VanillaAdmonition>'),
    ['A1'],
  );
});

test('A1 fires on a self-closing admonition', () => {
  assert.deepEqual(rules('<VanillaAdmonition type="note" title="x" />'), ['A1']);
});

test('A1 fires when the body is only whitespace across lines', () => {
  assert.deepEqual(rules('<VanillaAdmonition type="note" title="x">\n\n</VanillaAdmonition>'), [
    'A1',
  ]);
});

test('A1 does not fire when the body has prose', () => {
  assert.deepEqual(
    rules('<VanillaAdmonition type="note" title="Heads up">\n\nReal body.\n\n</VanillaAdmonition>'),
    [],
  );
});

test('A2 fires on a type outside the component union', () => {
  const found = lintSource('<VanillaAdmonition type="caution">\n\nbody\n\n</VanillaAdmonition>');
  assert.deepEqual(
    found.map((f) => f.rule),
    ['A2'],
  );
  assert.match(found[0].message, /caution/);
});

test('A2 accepts every valid type', () => {
  for (const t of ['note', 'tip', 'info', 'warning', 'danger']) {
    assert.deepEqual(rules(`<VanillaAdmonition type="${t}">\n\nbody\n\n</VanillaAdmonition>`), []);
  }
});

test('A3 fires on an unconverted ::: directive', () => {
  const found = lintSource(':::info Resources\n\ntext\n\n:::');
  assert.deepEqual(
    found.map((f) => f.rule),
    ['A3', 'A3'],
  );
});

test('A3 does NOT fire inside a fenced code block', () => {
  // The regression that matters: partials-check R3 emits 208 warnings that are all inside fences.
  assert.deepEqual(rules('```md\n:::note\ntext\n:::\n```'), []);
});

test('A4 fires for a markdown link or inline code in title=', () => {
  assert.ok(
    lintSource(
      '<VanillaAdmonition type="note" title="see [docs](/docs/x)">\n\nb\n\n</VanillaAdmonition>',
    ).some((f) => f.rule === 'A4'),
  );
  assert.ok(
    lintSource('<VanillaAdmonition type="note" title="run `x`">\n\nb\n\n</VanillaAdmonition>').some(
      (f) => f.rule === 'A4',
    ),
  );
});

test('A4 does NOT fire on an HTML entity — JSX decodes those in attributes', () => {
  // `title="L1 fee &quot;baked in&quot;"` renders as `L1 fee "baked in"`, verified in a browser.
  assert.deepEqual(
    rules(
      '<VanillaAdmonition type="note" title="a &quot;b&quot;">\n\nbody\n\n</VanillaAdmonition>',
    ),
    [],
  );
});

test('A4 sees markup that follows an apostrophe in a double-quoted title', () => {
  // `["']([^"']*)["']` stops at the apostrophe and never reaches the backticks.
  assert.ok(
    lintSource(
      '<VanillaAdmonition type="note" title="it doesn\'t use `x`">\n\nb\n\n</VanillaAdmonition>',
    ).some((f) => f.rule === 'A4'),
  );
});

test('A4 does not fire on a plain title', () => {
  assert.deepEqual(
    rules('<VanillaAdmonition type="note" title="Plain title">\n\nbody\n\n</VanillaAdmonition>'),
    [],
  );
});

test('A1 does NOT fire when the body is only a fenced code block', () => {
  // The body is all spaces in the code-stripped text, so reading it from there reported a
  // populated admonition as empty.
  assert.deepEqual(
    rules('<VanillaAdmonition type="tip">\n\n```shell\ndocker run x\n```\n\n</VanillaAdmonition>'),
    [],
  );
});

test('A1 still fires on a genuinely empty body', () => {
  assert.deepEqual(
    rules('<VanillaAdmonition type="note" title="stranded prose here">\n\n</VanillaAdmonition>'),
    ['A1'],
  );
});

test('A5 fires on internal .md/.mdx link targets, in markdown and JSX', () => {
  assert.deepEqual(rules('see [x](/docs/a/b.mdx)'), ['A5']);
  assert.deepEqual(rules('see [x](../a/b.mdx#frag)'), ['A5']);
  assert.deepEqual(rules('<a href="/docs/a.md">x</a>'), ['A5']);
});

test('A5 ignores external and fragment targets', () => {
  assert.deepEqual(rules('[x](https://example.com/a.md)'), []);
  assert.deepEqual(rules('[x](#section)'), []);
  assert.deepEqual(rules('[x](/docs/a/b)'), []);
});

test('findings carry 1-indexed line numbers', () => {
  const found = lintSource('line1\nline2\n:::note\n');
  assert.equal(found[0].line, 3);
});

test('A6 does NOT fire on a Var in prose', () => {
  assert.deepEqual(rules('The current release is <Var name="nitroVersionTag" />.'), []);
});

test('A6 fires on a Var in a fenced code block', () => {
  const found = lintSource('```shell\ndocker run <Var name="latestNitroNodeImage" /> keygen\n```');
  assert.deepEqual(
    found.map((f) => f.rule),
    ['A6'],
  );
  assert.match(found[0].message, /fenced code block/);
});

test('A6 fires on a Var in an inline code span', () => {
  const found = lintSource('The image: `<Var name="latestNitroNodeImage" />`');
  assert.deepEqual(
    found.map((f) => f.rule),
    ['A6'],
  );
  assert.match(found[0].message, /inline code span/);
});

test('A6 checks fenced blocks inside a partial too', () => {
  // Partials have no frontmatter and are consumed via <include>, but lintSource itself is
  // frontmatter-agnostic: it is only ever handed the raw text of one file, partial or page.
  const found = lintSource(
    '<include cwd>content/partials/_reference-nitro-cli.mdx</include>\n\n```shell\n<Var name="latestNitroNodeImage" />\n```',
  );
  assert.deepEqual(
    found.map((f) => f.rule),
    ['A6'],
  );
});

test('extractLocalImageSrcs finds an ImageZoom local src', () => {
  const found = extractLocalImageSrcs('<ImageZoom src="/img/a.png" alt="a" />');
  assert.deepEqual(found, [{ element: 'ImageZoom', src: '/img/a.png', line: 1 }]);
});

test('extractLocalImageSrcs handles a multi-line JSX opening tag', () => {
  // Line is where the tag opens, matching extractRemoteImages' own convention — not where `src=`
  // itself sits, which for a multi-line tag is a line later.
  const source = ['<ImageZoom', '  src="/img/a.svg"', '  alt="a"', '/>'].join('\n');
  const found = extractLocalImageSrcs(source);
  assert.deepEqual(found, [{ element: 'ImageZoom', src: '/img/a.svg', line: 1 }]);
});

test('extractLocalImageSrcs ignores a remote src', () => {
  assert.deepEqual(extractLocalImageSrcs('<ImageZoom src="https://example.com/a.png" />'), []);
});

test('extractLocalImageSrcs ignores a local src with no image extension', () => {
  assert.deepEqual(extractLocalImageSrcs('<a href="/docs/a">x</a>'), []);
});

test('extractLocalImageSrcs ignores a src inside a fenced code block', () => {
  assert.deepEqual(extractLocalImageSrcs('```mdx\n<ImageZoom src="/img/a.png" />\n```'), []);
});

test('extractLocalImageSrcs accepts every common image extension', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'avif']) {
    const found = extractLocalImageSrcs(`<ImageZoom src="/img/a.${ext}" />`);
    assert.equal(found.length, 1, ext);
  }
});

test('extractLocalImageSrcs strips a query string or fragment before matching the extension', () => {
  assert.deepEqual(extractLocalImageSrcs('<ImageZoom src="/img/a.png?v=2" />'), [
    { element: 'ImageZoom', src: '/img/a.png?v=2', line: 1 },
  ]);
});

test('A7 fires when a local image src has no file under public/', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'content-lint-'));
  try {
    mkdirSync(path.join(root, 'content'), { recursive: true });
    mkdirSync(path.join(root, 'public', 'img'), { recursive: true });
    writeFileSync(path.join(root, 'public', 'img', 'present.png'), 'x');

    const page = path.join(root, 'content', 'page.mdx');
    writeFileSync(
      page,
      [
        '<ImageZoom src="/img/present.png" alt="ok" />',
        '<ImageZoom src="/img/missing.png" alt="broken" />',
      ].join('\n'),
    );

    const found = lintContent(root);
    assert.deepEqual(
      found.map((f) => f.rule),
      ['A7'],
    );
    assert.equal(found[0].line, 2);
    assert.match(found[0].message, /missing\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A7 ignores a remote src and a non-image src', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'content-lint-'));
  try {
    mkdirSync(path.join(root, 'content'), { recursive: true });
    const page = path.join(root, 'content', 'page.mdx');
    writeFileSync(
      page,
      ['<ImageZoom src="https://example.com/a.png" />', '<a href="/docs/missing-page">x</a>'].join(
        '\n',
      ),
    );

    assert.deepEqual(lintContent(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lintContent({ files }) lints only the given files, not the whole tree', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'content-lint-'));
  try {
    mkdirSync(path.join(root, 'content'), { recursive: true });
    const clean = path.join(root, 'content', 'clean.mdx');
    const dirty = path.join(root, 'content', 'dirty.mdx');
    writeFileSync(clean, 'nothing wrong here\n');
    writeFileSync(dirty, ':::caution\nbad\n:::\n');

    // Walking the whole tree finds both ::: lines in dirty.mdx, none in clean.mdx.
    assert.equal(lintContent(root).length, 2);

    // Restricting to one file (repo-root-relative) finds only that file's findings.
    const onlyClean = lintContent(root, { files: ['content/clean.mdx'] });
    assert.deepEqual(onlyClean, []);

    const onlyDirty = lintContent(root, { files: [dirty] });
    assert.equal(onlyDirty.length, 2);
    assert.ok(onlyDirty.every((f) => f.rel === 'content/dirty.mdx'));

    // A non-mdx path in `files` is silently skipped.
    const nonMdx = path.join(root, 'content', 'readme.txt');
    writeFileSync(nonMdx, ':::caution\n:::\n');
    assert.deepEqual(lintContent(root, { files: [nonMdx] }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
