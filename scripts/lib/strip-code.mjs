/**
 * strip-code. The one answer to "what counts as code" for the scripts that scan MDX source.
 *
 * Both linters over `content/` share it: `content-lint` (every A rule matches against the stripped
 * text, so syntax *documented* in a fence is never mistaken for syntax) and the partials tooling
 * (`parseIncludes`/`parsePartialImports` in `partials.mjs`, so an `<include>` shown as an example is
 * not counted as a real dependency by `partials-check`, `CATALOG.md` or `manifest.json`). It lives in
 * its own module rather than in either of them because `content-lint.mjs` already imports
 * `partials.mjs`, so the helper cannot sit in `content-lint.mjs` without a cycle.
 *
 * Two other strippers still exist and are deliberately untouched: `maskRegions` in `doc-links.mjs`
 * (line-based fence tracking, run-paired code spans, and it also blanks frontmatter and HTML
 * comments, which a linter must not do) and `stripCodeFences`/`stripInlineCode` in
 * `remote-images.mjs`. Converging them would move rule coverage in three gates at once.
 */

/**
 * Blank fenced code blocks, inline code spans and MDX expression comments to spaces, preserving
 * every newline.
 *
 * The output is the same length as the input and every surviving character keeps its index, so a
 * caller may match against the stripped text and then read the matched span back out of the original
 * source at the same offsets. That is what lets `content-lint` read an attribute value that contains
 * inline code, and what lets `parseIncludes` return ranges a rewrite can splice.
 *
 * Three passes run in this order, and the order is load-bearing:
 *
 * 1. Fenced blocks, backtick and tilde, info string and all. This runs first so that a construct
 *    the later passes recognise is inert once it is shown inside a fence: a `{/*` written in a code
 *    sample never opens a comment, because the fence pass has already blanked it.
 * 2. Single-backtick inline spans, bounded to one line. This runs before the comment pass so that a
 *    backticked `{/*` and a backticked `*\/}` in ordinary prose, which in MDX are code spans and
 *    never comment delimiters, cannot pair with each other and blank the real content between them.
 * 3. `{/* … *\/}` comments, which may span lines.
 *
 * Fence indentation, as measured rather than as specified: the opening fence may be indented any
 * amount, and the closing fence is accepted at either the opener's exact indentation or at 0 to 3
 * spaces or tabs. Both alternatives are needed. The first is what closes a fence nested four or more
 * columns deep inside a list item, which is ordinary in `content/`; the second is what closes a
 * lightly indented fence under an unindented opener. This is not CommonMark conformance and does not
 * claim to be: CommonMark measures the closer's indentation relative to its container block, and a
 * flat regex has no notion of containers.
 *
 * Fence run length, also as measured: the closer must repeat the opener's character, backtick for
 * backtick and tilde for tilde, but its length is not constrained by the opener's. Any run of three
 * or more closes, because the opening quantifier backtracks and the opener's surplus characters are
 * absorbed into the info string. A three-backtick line therefore closes a four-backtick opener. That
 * is looser than CommonMark and predates FS-2723. Two files in `content/` open four-backtick fences
 * around nested three-backtick ones, and both strip cleanly today, so this is recorded rather than
 * tightened; tightening it would change what three gates see and wants its own change.
 *
 * Known limits:
 *
 * - A four-space-indented code block, the fenceless kind, is not modelled at all.
 * - A double-backtick span is not modelled. Its delimiters are blanked by pass 2 but its body is
 *   not, so a construct inside one is still visible to the caller.
 * - An unclosed fence blanks nothing on its own, but if a later line opens a fence of the same
 *   character, the two pair up and everything between them is blanked, which can swallow real prose
 *   between an accidental opener and the next real one.
 * - An odd number of backticks inside a single-line comment can pair with a later backtick on that
 *   same line, which breaks the comment's delimiters and leaves the comment unblanked. Pass 2 is
 *   bounded to one line, so this cannot reach across lines.
 */
export function stripCode(source) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/^([ \t]*)(`{3,}|~{3,})[\s\S]*?^(?:\1|[ \t]{0,3})\2[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank);
}
