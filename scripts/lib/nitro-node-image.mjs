/**
 * nitro-node-image — keep hardcoded copies of `latestNitroNodeImage` in step with `vars.json`.
 *
 * `<Var name="latestNitroNodeImage" />` renders nothing inside a fenced code block or an inline code
 * span (content-lint rule A6), so a `docker run` command a reader is meant to copy has to carry the
 * image tag literally. `check-nitro-release` bumps the variable and opens a PR; without this, those
 * literals keep the old tag while the prose beside them advertises the new one, and no gate sees it.
 *
 * The rewrite matches the **outgoing** value exactly — the one string `vars.json` is moving away
 * from — so it can only ever touch a copy of what was current. `content/` holds dozens of older
 * `offchainlabs/nitro-node:v…` literals pinned deliberately in historical examples; none of them
 * equal the outgoing value, so none of them are rewritten. That exactness is the whole safety
 * argument: a prefix or pattern match would need a judgement call about intent, and this does not.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { toPosix, walk } from './partials.mjs';

const isMdx = (p) => /\.mdx?$/i.test(p);

/**
 * Replace every occurrence of `from` with `to` in `source`.
 * Returns the new text and the number of replacements, so a caller can report what it changed.
 */
export function rewriteImage(source, from, to) {
  if (!from || from === to) return { text: source, count: 0 };

  let count = 0;
  let text = '';
  let at = 0;
  for (;;) {
    const hit = source.indexOf(from, at);
    if (hit === -1) break;
    text += source.slice(at, hit) + to;
    at = hit + from.length;
    count++;
  }
  return { text: text + source.slice(at), count };
}

/**
 * Rewrite the outgoing image tag across the content tree.
 *
 * Returns one entry per file changed, `{ rel, count }`, repo-relative and POSIX-separated so the
 * caller's log reads the same on every platform. Pass `write: false` to report without touching
 * disk.
 */
export function syncImageInContent(repoRoot, from, to, { dir = 'content', write = true } = {}) {
  const changed = [];
  if (!from || from === to) return changed;

  for (const abs of walk(path.join(repoRoot, dir), isMdx)) {
    const source = readFileSync(abs, 'utf8');
    const { text, count } = rewriteImage(source, from, to);
    if (count === 0) continue;
    if (write) writeFileSync(abs, text);
    changed.push({ rel: toPosix(path.relative(repoRoot, abs)), count });
  }
  return changed;
}
