/**
 * strip-code. The shared suite for the one scanner every content gate now uses (FS-2729).
 *
 * It carries the 29-case matrix the FS-2723 review built against the old regex `stripCode`, the two
 * limits that review documented rather than fixed (both marked below, both now passing), and the
 * cases the three replaced helpers used to own. Where a case asserts a rule of CommonMark, the
 * expectation was checked against `mdast-util-from-markdown` rather than reasoned about.
 *
 * Every case also asserts the contract: same length in and out, same line count, so a `file:line` in
 * any report stays true and a range still slices the original source.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codeRegions, maskCode, maskRegions, stripCode } from './strip-code.mjs';

/** Strip, asserting the length and line-count invariant on the way through. */
function strip(source, options) {
  const out = options === undefined ? stripCode(source) : maskCode(source, options);
  assert.equal(out.length, source.length, 'length must be preserved');
  assert.equal(out.split('\n').length, source.split('\n').length, 'line count must be preserved');
  return out;
}

const blanked = (source, needle, options) => !strip(source, options).includes(needle);
const kept = (source, needle, options) => strip(source, options).includes(needle);

const lines = (...rows) => rows.join('\n');

// --- Fences: run length ------------------------------------------------------------------------

test('a closing run longer than the opening run closes the fence', () => {
  const src = lines('```', 'HIDDEN', '````', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a closing run shorter than the opening run does not close the fence', () => {
  // FS-2723 residual limit A, which the regex scanner could not express. It now passes.
  const src = lines('````', 'HIDDEN_A', '```', 'HIDDEN_B', '````', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN_A'));
  assert.ok(blanked(src, 'HIDDEN_B'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a tilde run does not close a backtick fence', () => {
  const src = lines('```', '~~~', 'HIDDEN', '```', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a backtick run does not close a tilde fence', () => {
  const src = lines('~~~', '```', 'HIDDEN', '~~~', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a backtick run inside a four-backtick fence is not a closer', () => {
  const src = lines('````markdown', '```js', 'HIDDEN', '```', 'STILL_HIDDEN', '````', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(blanked(src, 'STILL_HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

// --- Fences: indentation -----------------------------------------------------------------------

test('a three-space indented fence closes at its own indentation', () => {
  const src = lines('   ```mdx', '   HIDDEN', '   ```', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a two-space indented closer closes an unindented opener', () => {
  const src = lines('```', 'HIDDEN', '  ```', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a four-space indented closer does not close an unindented opener', () => {
  // Checked against mdast-util-from-markdown: a closer more than three columns past its container
  // is content, not a closer. `content/docs/launch-arbitrum-chain/integrations/…` writes one.
  const src = lines('```json', 'HIDDEN', '    ```', 'STILL_HIDDEN', '```', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(blanked(src, 'STILL_HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a zero-indent closer closes a two-space opener', () => {
  const src = lines('  ```', '  HIDDEN', '```', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a fence indented four spaces closes at its own indentation', () => {
  const src = lines('Paste this:', '', '    ```mdx', '    HIDDEN', '    ```', '', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a fence indented six spaces inside a nested list item closes', () => {
  const src = lines(
    '- Step one:',
    '',
    '  1. Paste this:',
    '',
    '      ```mdx',
    '      HIDDEN',
    '      ```',
    '',
    'SHOWN',
    '',
  );
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a tab-indented opener and closer pair', () => {
  const src = lines('\t```', '\tHIDDEN', '\t```', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

// --- Fences: info strings, closers and the unterminated case -----------------------------------

test('an info string and meta on the opener are blanked with the fence', () => {
  const src = lines('```mdx title="x.mdx"', 'HIDDEN', '```', 'SHOWN', '');
  assert.ok(blanked(src, 'title="x.mdx"'));
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a line carrying trailing text after its run does not close a fence', () => {
  // Checked against mdast-util-from-markdown. This is what keeps a ```json line inside an open
  // fence from being read as that fence's closer.
  const src = lines('```js', 'HIDDEN', '``` trailing', 'STILL_HIDDEN', '```', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(blanked(src, 'STILL_HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('an unterminated fence runs to the end of the file', () => {
  // A behaviour change from the regex scanner, which blanked nothing at all here and left the rest
  // of the file readable. CommonMark, and the rendered page, put everything after the opener inside
  // the code block. `content/docs/stylus/how-tos/trait-based-composition.mdx` ends on one.
  const src = lines('SHOWN', '```', 'HIDDEN', 'ALSO_HIDDEN', '');
  assert.ok(kept(src, 'SHOWN'));
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(blanked(src, 'ALSO_HIDDEN'));
});

test('a four-space indented code block is not modelled', () => {
  // A documented limit, pinned so a later change to it is deliberate.
  assert.ok(kept(lines('Text:', '', '    SHOWN', ''), 'SHOWN'));
});

test('prose between two fences survives', () => {
  const src = lines('```', 'HIDDEN_A', '```', '', 'SHOWN', '', '```', 'HIDDEN_B', '```', '');
  assert.ok(blanked(src, 'HIDDEN_A'));
  assert.ok(blanked(src, 'HIDDEN_B'));
  assert.ok(kept(src, 'SHOWN'));
});

// --- Inline code spans -------------------------------------------------------------------------

test('an inline code span is blanked', () => {
  assert.ok(blanked('use `HIDDEN` here', 'HIDDEN'));
});

test('a double-backtick span blanks its body, single backticks included', () => {
  const src = 'a ``HIDDEN with a ` tick`` SHOWN';
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a run closes only on a run of exactly the same length', () => {
  // `a` is inside the double-backtick span; the lone run of one never opens anything.
  const src = 'x ``HIDDEN`` y `SHOWN_NOT_A_SPAN';
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN_NOT_A_SPAN'));
});

test('an unmatched backtick run is literal text', () => {
  const src = lines('SHOWN and a stray ` backtick', '');
  assert.ok(kept(src, 'SHOWN'));
  assert.ok(kept(src, 'backtick'));
});

test('a code span may cross a newline', () => {
  assert.ok(blanked(lines('a `HIDDEN', 'STILL_HIDDEN` b', ''), 'HIDDEN'));
  assert.ok(blanked(lines('a `HIDDEN', 'STILL_HIDDEN` b', ''), 'STILL_HIDDEN'));
});

test('a code span does not cross a blank line', () => {
  // Checked against mdast-util-from-markdown: inline parsing is confined to one block. Without this
  // a stray backtick pairs with one paragraphs away and hides every line between, which is what
  // `content/docs/how-arbitrum-works/bold/bold-technical-deep-dive.mdx` triggers.
  const src = lines('a `SHOWN_A', '', 'SHOWN_B ` c', '');
  assert.ok(kept(src, 'SHOWN_A'));
  assert.ok(kept(src, 'SHOWN_B'));
});

test('a backtick inside a fence never opens a span', () => {
  const src = lines('```', 'HIDDEN `', '```', '', 'SHOWN ` and more SHOWN_TOO', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN_TOO'));
});

// --- MDX comments ------------------------------------------------------------------------------

test('a single-line MDX comment is blanked', () => {
  assert.ok(blanked('{/* HIDDEN */}', 'HIDDEN'));
});

test('a multi-line MDX comment is blanked without losing what follows', () => {
  const src = lines('{/*', 'HIDDEN', '*/}', '', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('an MDX comment containing an inline code span is blanked whole', () => {
  const src = lines('{/* the `x` form: HIDDEN */}', '', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('an unbalanced backtick straddling a comment closer still closes the comment', () => {
  // FS-2723 residual limit B. Two ordered passes could not get this and backticked delimiters in
  // prose both right; one left-to-right scan gets both. It now passes.
  const src = lines('{/* HIDDEN `a */} b`', '', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('backticked comment delimiters in prose do not swallow the content between them', () => {
  const src = lines('Write `{/*` to open one.', '', 'SHOWN', '', 'Close it with `*/}`.', '');
  assert.ok(kept(src, 'SHOWN'));
});

test('an MDX comment opener inside a fence opens nothing', () => {
  const src = lines('```', '{/*', '```', '', 'SHOWN', '');
  assert.ok(kept(src, 'SHOWN'));
});

test('a stray comment closer with no opener blanks nothing', () => {
  const src = lines('SHOWN */} still SHOWN_TOO', '');
  assert.ok(kept(src, 'SHOWN_TOO'));
});

test('two complete comments leave the content between them', () => {
  const src = lines('{/* HIDDEN_A */}', '', 'SHOWN', '', '{/* HIDDEN_B */}', '');
  assert.ok(blanked(src, 'HIDDEN_A'));
  assert.ok(blanked(src, 'HIDDEN_B'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a complete MDX comment beside a JSX element is blanked', () => {
  const src = lines('<Foo bar={1} /> {/* HIDDEN */}', '', 'SHOWN', '');
  assert.ok(blanked(src, 'HIDDEN'));
  assert.ok(kept(src, 'SHOWN'));
});

test('a JavaScript comment inside a JSX expression is not an MDX comment', () => {
  // `{/*` opens only against `*/}`. Here the expression closes with `*/ 1}`, so nothing pairs and
  // nothing is blanked, which is the conservative direction.
  const src = lines('<Foo bar={/* SHOWN_A */ 1} />', '', 'SHOWN_B', '');
  assert.ok(kept(src, 'SHOWN_A'));
  assert.ok(kept(src, 'SHOWN_B'));
});

test('an unclosed MDX comment blanks nothing', () => {
  assert.ok(kept('{/* SHOWN', 'SHOWN'));
});

// --- Region sets per consumer ------------------------------------------------------------------

test('stripCode leaves frontmatter and HTML comments visible', () => {
  const src = lines('---', 'title: SHOWN_TITLE', '---', '', '<!-- SHOWN_COMMENT -->', '');
  assert.ok(kept(src, 'SHOWN_TITLE'));
  assert.ok(kept(src, 'SHOWN_COMMENT'));
});

test('maskRegions blanks frontmatter and HTML comments and leaves MDX comments visible', () => {
  const src = lines(
    '---',
    'title: HIDDEN_TITLE',
    '---',
    '',
    '<!-- HIDDEN -->',
    '{/* SHOWN */}',
    '',
  );
  const out = maskRegions(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(!out.includes('HIDDEN_TITLE'));
  assert.ok(!out.includes('HIDDEN'));
  assert.ok(out.includes('SHOWN'));
});

test('the default region set is fences and inline code only', () => {
  const src = lines('---', 'title: SHOWN_A', '---', '', '<!-- SHOWN_B -->', '{/* SHOWN_C */}', '');
  const out = maskCode(src);
  assert.ok(out.includes('SHOWN_A'));
  assert.ok(out.includes('SHOWN_B'));
  assert.ok(out.includes('SHOWN_C'));
});

test('a backtick inside frontmatter cannot pair with one in the body', () => {
  const src = lines('---', 'title: a ` tick', '---', '', 'SHOWN and a ` tick', '');
  const out = maskRegions(src);
  assert.ok(out.includes('SHOWN'));
});

test('an HTML comment whose closer sits inside a code span is still blanked', () => {
  const src = lines('<!-- HIDDEN `a --> b` -->', '', 'SHOWN', '');
  const out = maskRegions(src);
  assert.ok(!out.includes('HIDDEN'));
  assert.ok(out.includes('SHOWN'));
});

// --- Regions ------------------------------------------------------------------------------------

test('codeRegions returns ranges that slice the original source', () => {
  const src = lines('a `span` b', '', '```js', 'const x = 1;', '```', '');
  const found = codeRegions(src, { mdxComments: true });
  assert.deepEqual(
    found.map((r) => [r.kind, src.slice(r.start, r.end)]),
    [
      ['inlineCode', '`span`'],
      ['fence', '```js\nconst x = 1;\n```'],
    ],
  );
});

test('codeRegions is in source order and non-overlapping', () => {
  const src = lines('`a`', '', '```', 'x', '```', '', '{/* c */}', '`b`', '');
  const found = codeRegions(src, { mdxComments: true });
  for (let i = 1; i < found.length; i++) assert.ok(found[i].start >= found[i - 1].end);
});

// --- The contract, on shapes that used to be handled by three different helpers -----------------

test('the contract holds over an emoji, whose two halves both count', () => {
  const src = 'a 🚀 `code` b';
  const out = strip(src);
  assert.equal(out.indexOf('b'), src.indexOf('b'));
});

test('the contract holds over a fence, which the images helper used to collapse', () => {
  const src = lines('a', '```js', 'const x = 1;', '```', 'b', '');
  strip(src, {});
});

test('the contract holds over an inline span across lines', () => {
  strip(lines('a `x` b', 'c `d` e', ''), {});
});
