/**
 * var-links — expand `{var:name}` placeholders inside markdown link destinations.
 *
 * `<Var name="…" />` cannot be used in a link destination, and the failure is silent. CommonMark
 * reads an unbracketed destination as one raw token that may not contain a space, so
 * `[Interface](https://github.com/OffchainLabs/<Var name="nitroRepositorySlug" />/blob/…)` fails to
 * parse as a link at all: the reader is served the literal `[Interface](…)` brackets, with only the
 * bare URL prefix before the first `<Var>` autolinked by GFM. Nothing caught it — `vars:check` only
 * proves the key exists, `check-links` skips external destinations, and `content:lint` rule A6 reads
 * code fences and spans. Seventy-three links across five pages shipped that way (FS-2725).
 *
 * The placeholder form parses, because it holds no space:
 *
 *   [Interface](https://github.com/OffchainLabs/{var:nitroRepositorySlug}/blob/{var:nitroVersionTag}/x.go)
 *
 * The braces survive verbatim in the mdast `link` node's `url`, and this plugin substitutes them.
 * Several placeholders in one destination are fine, which is what the precompiles table needs. The
 * same placeholder works in a JSX `href`, `to` or `src` attribute, where a `<Var>` tag is broken for
 * a different reason: its own quotes close the attribute value early.
 *
 * The `var:` prefix is not decoration. Without it a placeholder is indistinguishable from a URL that
 * documents a path template (`…/{chainId}/…`), and `vars:check` would have to choose between letting
 * a mistyped name ship silently and failing on a legitimate template. With it, an unknown name is
 * unambiguously a mistake, so the gate can be strict.
 *
 * An unknown name is left in place rather than thrown on, matching what `<Var>` does with one: the
 * defect reaches the page as visible nonsense and `pnpm vars:check` is the gate that fails on it.
 * Throwing here would take the whole site down for one typo, in a module that runs before any page.
 *
 * Deliberately import-free apart from `node:fs`/`node:url`, so `scripts/lib/var-links.test.mjs` can
 * import it under `node --test` and exercise the real module rather than a copy.
 */
import { readFileSync } from 'node:fs';

/**
 * A `{var:name}` placeholder. The name matches a JavaScript identifier, which is the shape every
 * key in `content/vars.json` has; anything else is not a placeholder and is left alone, so a URL
 * that happens to contain braces is never touched.
 */
export const VAR_PLACEHOLDER = /\{var:([A-Za-z_]\w*)\}/g;

/**
 * Something that opens like a placeholder but whose name is not an identifier — `{var:}`,
 * `{var:two words}`. Reported by the gate rather than substituted, because silently leaving it
 * would put literal braces in a URL.
 */
export const MALFORMED_VAR_PLACEHOLDER = /\{var:(?![A-Za-z_]\w*\})[^}\n]*\}/g;

/** Every placeholder name in a string, in source order, with duplicates kept. */
export function varPlaceholderNames(source) {
  return [...String(source).matchAll(VAR_PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Substitute every resolvable placeholder in `url`. `vars` is any object keyed by variable name;
 * a name it does not hold is left as written.
 */
export function expandVarPlaceholders(url, vars) {
  if (typeof url !== 'string' || !url.includes('{var:')) return url;
  return url.replace(VAR_PLACEHOLDER, (whole, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}

/** Depth-first walk over an mdast tree, visiting every node. */
function walkTree(node, visit) {
  visit(node);
  for (const child of node?.children ?? []) walkTree(child, visit);
}

/**
 * JSX attributes that carry a URL. A `<Var>` inside one of these is broken for a second reason —
 * the tag's own `name="…"` quotes close the attribute value early and truncate the URL — so the
 * placeholder has to work here too, or `content:lint` rule A11 would have no fix to name for that
 * shape.
 */
const URL_ATTRIBUTES = new Set(['href', 'to', 'src']);

/**
 * The remark plugin. Rewrites `link` and `definition` urls, and the URL attributes of a JSX element.
 *
 * Not markdown `image` nodes: fumadocs' own remark-image plugin rewrites those, this plugin is
 * appended to `remarkPlugins` and so has no pinned position relative to it, and no image in
 * `content/` uses a variable. Covering them later means pinning the order first.
 *
 * `definition` is included because a reference-style link (`[text][ref]`) keeps its destination in a
 * definition node, and a writer who reaches for one should not find the mechanism missing.
 */
export function remarkVarLinks({ vars } = {}) {
  const values = vars ?? readVars();
  return (tree) => {
    walkTree(tree, (node) => {
      if (node?.type === 'link' || node?.type === 'definition') {
        node.url = expandVarPlaceholders(node.url, values);
        return;
      }
      if (node?.type !== 'mdxJsxFlowElement' && node?.type !== 'mdxJsxTextElement') return;
      for (const attr of node.attributes ?? []) {
        // Only a literal string value. An expression attribute (`href={…}`) is JavaScript the MDX
        // compiler owns, and rewriting inside it would be rewriting code.
        if (attr?.type !== 'mdxJsxAttribute' || typeof attr.value !== 'string') continue;
        if (!URL_ATTRIBUTES.has(attr.name)) continue;
        attr.value = expandVarPlaceholders(attr.value, values);
      }
    });
  };
}

/**
 * Read `content/vars.json` off disk, resolved from this file rather than from the working
 * directory: the plugin is loaded by `source.config.ts` during a build and by `check-links`, which
 * run from different places.
 *
 * The JSON is read rather than `content/vars.ts` imported, because this module is plain JavaScript
 * and Node cannot import the TypeScript schema. The two cannot drift in the direction that matters:
 * `varsSchema` is a `z.strictObject`, so a JSON key absent from the schema throws at module load
 * long before anything renders.
 */
export function readVars() {
  return JSON.parse(readFileSync(new URL('../content/vars.json', import.meta.url), 'utf8'));
}
