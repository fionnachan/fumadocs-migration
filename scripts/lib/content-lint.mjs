/**
 * content-lint — structural defects in MDX that no existing gate can see.
 *
 * Every rule ignores fenced and inline code. That is not optional: `partials-check` R3 currently emits
 * 208 warnings that are all component-looking text inside code fences, and a rule that cannot tell
 * documentation-about-syntax from syntax is noise, not a gate.
 *
 * Rules:
 *   A1  VanillaAdmonition with an empty body — the `:::type`→component codemod moved body prose into
 *       `title=`, leaving the box blank and the prose styled as a heading.
 *   A2  VanillaAdmonition `type` outside the component's union (note|tip|info|warning|danger); anything
 *       else indexes `styles[type]` as undefined and renders unstyled.
 *   A3  Unconverted Docusaurus `:::` directive — renders as literal `:::caution` text to readers.
 *   A4  Markdown syntax inside a `title=` attribute — `title` is a plain string prop, so
 *       `[text](/docs/x)` renders literally and the link is unclickable. HTML entities are not
 *       flagged: JSX decodes those in attribute values, so they render as intended.
 *   A5  Internal link target keeping a `.md`/`.mdx` suffix — 404s at runtime.
 *   A6  `<Var>` inside a fenced code block or inline code span. MDX does not evaluate components
 *       inside code, so the reader sees the literal `<Var name="…" />` tag instead of its value.
 *       Coverage matches `stripCode`, which models backtick and tilde fences and single-backtick
 *       spans only: a `<Var>` inside a four-space-indented block or a double-backtick span is not
 *       flagged. Widening A6 alone would make it disagree with A1..A5 about what "code" is, so the
 *       two move together or not at all. Neither form appears in `content/`.
 *   A7  A JSX/component `src` pointing at a local (site-relative) image with no file under
 *       `public/`. `<ImageZoom src="/img/…">` is a plain `<img>`, so this is the one image path
 *       nothing else validates: `pnpm images:presence` only blocks a *remote* src on *markdown*
 *       syntax, `remarkImageOptions.useImport` only fails the build on a *local* src on *markdown*
 *       syntax, and `check-links` walks MDX links, not component props. A dead `src` here renders a
 *       broken `<img>` and every gate stays green (FS-2700). Restricted to common image extensions
 *       so a `src` pointing at a route rather than an asset is never mistaken for a missing file.
 *
 * A8, A9 and A10 are one family: HTML the browser's parser has to restructure before it can build a
 * tree. React then hydrates a client tree that does not match the server tree, throws error #418, and
 * discards and re-renders the whole subtree. Eighteen of 350 routes did this and every gate stayed
 * green, because each page still returns HTTP 200 and compiles (FS-2714). They are three ids rather
 * than one because the report groups by id and each shape has its own fix; a single "invalid nesting"
 * id would print one count covering three unrelated edits.
 *
 *   A8  A link inside a heading. Fumadocs wraps every heading's content in its own `<a href="#slug">`
 *       anchor, so a heading that already contains a link renders `<a><a>…</a></a>`, which no HTML
 *       parser can represent. Covers a markdown inline link, a reference link (`[text][ref]` and
 *       `[text][]`), a bare URL or angle autolink (GFM anchors both), and a raw `<a>` element. A
 *       markdown *image* in a heading is fine and is not flagged: `<img>` nests inside an anchor
 *       legally, and nor is `[#custom-id]`, which is how a heading pins its slug.
 *   A9  A hand-written `<p>` whose children start on the next line. MDX parses a JSX element's
 *       children as *flow* content when they are on their own lines, so remark wraps the prose in a
 *       paragraph of its own and the element becomes `<p><p>…</p></p>`. Written inline
 *       (`<p>text</p>`) the children are phrasing content, remark adds nothing, and one paragraph is
 *       rendered, verified in the built HTML, so that form is not flagged. The generated precompile
 *       partials use it (`content/partials/precompile-tables/_ArbAggregator.mdx`), and flagging it
 *       would make this rule demand an edit to a do-not-edit file for markup that renders correctly.
 *   A10 A `<tr>` sitting directly inside a `<table>`. The parser inserts the `<tbody>` the source
 *       omitted, so the client tree gains an element the server tree does not have. Put every row in
 *       a `<thead>`, `<tbody>` or `<tfoot>`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { toPosix, walk } from './partials.mjs';

export const ADMONITION_TYPES = new Set(['note', 'tip', 'info', 'warning', 'danger']);
const isMdx = (p) => /\.mdx?$/i.test(p);

/** Blank out fenced blocks and inline code, preserving line count and offsets. */
export function stripCode(source) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/^([ \t]*)(`{3,}|~{3,})[\s\S]*?^\1?\2[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank);
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

export function lintSource(source) {
  const findings = [];
  const text = stripCode(source);
  const add = (rule, index, message) => findings.push({ rule, line: lineOf(text, index), message });

  // A1 + A2 + A4 — walk every admonition opening tag.
  //
  // Match against the code-stripped text so admonitions *documented inside* a fence are ignored, but
  // read attribute values from the original source at the same offsets: `stripCode` blanks characters
  // 1:1, so offsets are identical, and an inline-code span inside `title=` would otherwise be erased
  // before A4 could see it.
  for (const m of text.matchAll(/<VanillaAdmonition\b([^>]*?)(\/?)>/g)) {
    const [full, , selfClose] = m;
    const attrs = source.slice(m.index, m.index + full.length);
    const type = attrs.match(/\btype\s*=\s*["']([^"']*)["']/)?.[1];

    if (type !== undefined && !ADMONITION_TYPES.has(type)) {
      add('A2', m.index, `type="${type}" is not one of ${[...ADMONITION_TYPES].join('|')}`);
    }

    let body = null;
    if (selfClose === '/') body = '';
    else {
      // Locate the closer in the code-stripped text (so a closer inside a fence is ignored) but
      // read the body from `source`: a body consisting only of a fenced code block is all spaces
      // in `text`, which used to report a populated admonition as empty.
      const close = text.indexOf('</VanillaAdmonition>', m.index + full.length);
      if (close !== -1) body = source.slice(m.index + full.length, close);
    }
    if (body !== null && body.trim() === '') {
      add('A1', m.index, 'admonition body is empty — body prose likely moved into title=');
    }

    // A4 — `title` is a plain string prop, so markdown in it is printed verbatim.
    //
    // Match the closing quote to the opening one: `["']([^"']*)["']` stops at the first apostrophe
    // inside a double-quoted value ("…doesn't…"), truncating the title and hiding any markup after
    // it — that under-reported A4 by 4 findings.
    //
    // HTML entities are deliberately NOT flagged: JSX decodes them in attribute values, so
    // `title="L1 fee &quot;baked in&quot;"` renders as `L1 fee "baked in"` (verified in a browser).
    const title = attrs.match(/\btitle\s*=\s*(["'])((?:(?!\1).)*)\1/)?.[2];
    if (title) {
      const problems = [];
      if (/\]\(/.test(title)) problems.push('markdown link');
      if (/`/.test(title)) problems.push('inline code');
      if (problems.length) {
        add('A4', m.index, `title= contains ${problems.join(' + ')} which renders literally`);
      }
    }
  }

  // A3 — a line beginning with ::: outside code.
  for (const m of text.matchAll(/^[ \t]*:::+[^\n]*/gm)) {
    add('A3', m.index, `unconverted Docusaurus directive: ${m[0].trim().slice(0, 60)}`);
  }

  // A5 — internal link targets that keep a .md/.mdx suffix.
  const internal = (t) => t && !/^(?:[a-z]+:|\/\/|#)/i.test(t);
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (internal(m[1]) && /\.mdx?(?:#[^)]*)?$/i.test(m[1])) {
      add('A5', m.index, `link target keeps a .md/.mdx suffix: ${m[1]}`);
    }
  }
  for (const m of text.matchAll(/\b(?:href|to)\s*=\s*["']([^"']+)["']/g)) {
    if (internal(m[1]) && /\.mdx?(?:#[^"']*)?$/i.test(m[1])) {
      add('A5', m.index, `link target keeps a .md/.mdx suffix: ${m[1]}`);
    }
  }

  // A6: `<Var>` used inside code. MDX does not evaluate components inside a fenced block or an
  // inline code span, so the reader sees the literal `<Var name="…" />` tag, not its value.
  //
  // Walk fenced blocks and inline spans against `source` directly (not the code-stripped `text`,
  // which is exactly what we need to look *inside*), matching `stripCode`'s own regexes so a
  // fence's own backticks are never mistaken for an inline-code delimiter.
  const varRe = /<Var\b[^>]*\/?>/g;
  for (const m of source.matchAll(/^([ \t]*)(`{3,}|~{3,})[\s\S]*?^\1?\2[^\n]*$/gm)) {
    for (const vm of m[0].matchAll(varRe)) {
      add(
        'A6',
        m.index + vm.index,
        '<Var> inside a fenced code block renders as a literal tag, not its value',
      );
    }
  }
  const withoutFences = source.replace(/^([ \t]*)(`{3,}|~{3,})[\s\S]*?^\1?\2[^\n]*$/gm, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  for (const m of withoutFences.matchAll(/`[^`\n]*`/g)) {
    const span = source.slice(m.index, m.index + m[0].length);
    for (const vm of span.matchAll(varRe)) {
      add(
        'A6',
        m.index + vm.index,
        '<Var> inside an inline code span renders as a literal tag, not its value',
      );
    }
  }

  // A8: a link inside an ATX heading, which Fumadocs renders as an anchor inside its own anchor.
  //
  // Read the heading from the code-stripped text, so a heading shown inside a fence is skipped and
  // an inline code span in the heading (`### `https://x``) cannot be mistaken for an autolink.
  //
  // When a heading's slug is load-bearing, the escape hatch is Fumadocs' `[#custom-id]` syntax:
  // drop the link, then pin the old anchor with `## Heading text [#old-slug]`. That form is a lone
  // bracket pair, so no probe below fires on it, and there is a test pinning that.
  //
  // Known gap: a *shortcut* reference link (`[ref]` with its definition elsewhere in the file) is
  // character-for-character the shape of `[#custom-id]` and cannot be told apart without resolving
  // definitions, so it is not probed. The full and collapsed forms (`[text][ref]`, `[text][]`) are.
  for (const m of text.matchAll(/^#{1,6}[ \t]+([^\n]*)$/gm)) {
    const heading = m[1];
    const problems = [];

    // An inline or reference link, but not an image: `<img>` nests inside an anchor legally. The
    // alternation in the label allows one level of nested brackets, which is what
    // `[`#[storage]`](…)` needs.
    if (/(?<!!)\[(?:[^[\]]|\[[^[\]]*\])*\](?:\([^)]*\)|\[[^[\]]*\])/.test(heading)) {
      problems.push('a markdown link');
    }
    if (/<a[\s>]/i.test(heading)) problems.push('an <a> element');

    // Whatever is left once every link (and its destination) is removed. GFM turns a bare URL in
    // text into an anchor, so it nests exactly the same way a written-out link does. The tag strip
    // requires a real element name (letters, then an attribute list or the closer), so an angle
    // autolink such as `<https://x>` is not mistaken for a tag and erased: its `:` ends the name.
    const withoutLinks = heading
      .replace(/!?\[(?:[^[\]]|\[[^[\]]*\])*\](?:\([^)]*\)|\[[^[\]]*\])/g, ' ')
      .replace(/<\/?[A-Za-z][A-Za-z0-9.-]*(?:\s[^>]*)?\/?>/g, ' ');
    if (/(?:https?:\/\/|\bwww\.)\S/i.test(withoutLinks)) problems.push('a bare URL');

    if (problems.length) {
      add(
        'A8',
        m.index,
        `heading contains ${problems.join(' + ')}; Fumadocs wraps heading content in its own anchor, so this nests <a> inside <a>`,
      );
    }
  }

  // A9: a hand-written <p> whose opening tag ends its line, so its children are flow content and
  // remark wraps them in a paragraph of its own. See the header comment for why the inline form
  // (`<p>text</p>`) is left alone.
  for (const m of text.matchAll(/<p\b[^>]*>[ \t]*(?=\r?\n)/g)) {
    add(
      'A9',
      m.index,
      'hand-written <p> around block content; markdown wraps that prose in a paragraph already, so this renders <p> inside <p>',
    );
  }

  // A10: a <tr> that is a direct child of <table>, with no <thead>/<tbody>/<tfoot> between them.
  // Tracked with a depth counter rather than a regex, because the sections may appear in any order
  // and a table may hold several of them.
  for (const table of text.matchAll(/<table[\s>][\s\S]*?<\/table>/g)) {
    let depth = 0;
    for (const tok of table[0].matchAll(/<(\/?)(thead|tbody|tfoot|tr)\b/gi)) {
      const [, closing, name] = tok;
      if (name.toLowerCase() === 'tr') {
        if (depth === 0 && !closing) {
          add(
            'A10',
            table.index + tok.index,
            '<tr> is a direct child of <table>; the browser inserts the missing <tbody>, so put every row in a <thead>, <tbody> or <tfoot>',
          );
        }
        continue;
      }
      depth += closing ? -1 : 1;
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/**
 * A JSX element's `src` attribute, when it is a local (site-relative) path to a common image
 * format. Mirrors `extractRemoteImages`' `JSX_SRC` in `remote-images.mjs` (any element, either
 * quote style, tolerant of a `{'…'}` wrapper), restricted by extension rather than by an
 * element allowlist so a new image-taking component needs no update here — the allowlist would
 * only need to grow, never shrink, and a missed entry would silently exempt a component.
 *
 * Markdown-syntax local images are deliberately not this function's business:
 * `remarkImageOptions.useImport` already fails the build on those.
 */
const JSX_LOCAL_IMAGE_SRC = /<([A-Za-z][\w.]*)\b[^>]*?\bsrc\s*=\s*["'{]\s*["']?(\/[^"'\s{}]+)/g;
const LOCAL_IMAGE_EXT = /\.(?:png|jpe?g|svg|gif|webp|avif)(?:[?#][^"'\s{}]*)?$/i;

export function extractLocalImageSrcs(source) {
  const text = stripCode(source);
  const found = [];
  for (const m of text.matchAll(JSX_LOCAL_IMAGE_SRC)) {
    if (!LOCAL_IMAGE_EXT.test(m[2])) continue;
    found.push({ element: m[1], src: m[2], line: lineOf(text, m.index) });
  }
  return found;
}

/**
 * A7 findings for one file's source: every local image `src` with no counterpart under
 * `public/`. Needs `repoRoot` to resolve the file on disk, which is why this lives beside
 * `lintContent` rather than inside the pure, fs-free `lintSource`.
 */
function lintLocalImages(repoRoot, source) {
  return extractLocalImageSrcs(source).flatMap(({ element, src, line }) => {
    const clean = src.split(/[?#]/)[0];
    if (existsSync(path.join(repoRoot, 'public', clean))) return [];
    return [{ rule: 'A7', line, message: `${element} src="${src}" has no file at public${clean}` }];
  });
}

/**
 * Lint every MDX file under `content/`, newest-defect-first by rule then path.
 *
 * Pass `files` (absolute or repo-root-relative paths) to lint only those files instead of
 * walking `dir` — used by the pre-commit hook (lint-staged) so a single-file commit does not
 * pay for a full-tree walk. Non-MDX paths in `files` are silently skipped, matching the walk's
 * own `isMdx` filter.
 */
export function lintContent(repoRoot, { dir = 'content', files } = {}) {
  const out = [];
  const targets = files
    ? files.map((f) => (path.isAbsolute(f) ? f : path.resolve(repoRoot, f))).filter(isMdx)
    : walk(path.join(repoRoot, dir), isMdx);
  for (const abs of targets) {
    const rel = toPosix(path.relative(repoRoot, abs));
    const source = readFileSync(abs, 'utf8');
    const findings = [...lintSource(source), ...lintLocalImages(repoRoot, source)].sort(
      (a, b) => a.line - b.line || a.rule.localeCompare(b.rule),
    );
    for (const f of findings) out.push({ rel, ...f });
  }
  return out;
}
