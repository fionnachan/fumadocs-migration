/**
 * strip-code — the one answer to "what counts as code" for the scripts that scan MDX source.
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
 * Blank fenced code blocks and inline code spans to spaces, preserving every newline.
 *
 * The output is the same length as the input and every surviving character keeps its index, so a
 * caller may match against the stripped text and then read the matched span back out of the original
 * source at the same offsets. That is what lets `content-lint` read an attribute value that contains
 * inline code, and what lets `parseIncludes` return ranges a rewrite can splice.
 *
 * Models backtick and tilde fences (an info string is fine, and the fence may be indented) and
 * single-backtick inline spans. It does not model a four-space-indented code block or a
 * double-backtick span; neither appears in `content/`. The closing fence must repeat the opening run
 * exactly, so an unclosed fence blanks nothing.
 */
export function stripCode(source) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/^([ \t]*)(`{3,}|~{3,})[\s\S]*?^\1?\2[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank);
}
