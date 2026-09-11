/**
 * Render the Nitro CLI flags reference page and splice it into the file on disk.
 *
 * The page is generated between two markers rather than written whole. Its frontmatter carries
 * the five fields `source.config.ts` requires plus `sidebar_label` and `user_story`, all of them
 * editorial, and a writer may want a paragraph of their own above or below the tables. Anything
 * outside the markers survives a regeneration untouched; anything inside is replaced.
 *
 * Ported from arbitrum-docs `scripts/generate-cli-reference.ts`, which rewrote the whole file
 * and so had no way to keep a local edit.
 */

export const START_MARKER = '{/* GENERATED:START */}';
export const END_MARKER = '{/* GENERATED:END */}';

const DO_NOT_EDIT =
  '{/* The region between the GENERATED markers below is written by ' +
  '`pnpm cli:generate` from the Nitro source at the tag pinned as `nitroVersionTag` in ' +
  'content/vars.json. Do not edit it by hand. Prose outside the markers is preserved. */}';

/** Frontmatter used only when the page does not exist yet. */
const SCAFFOLD_FRONTMATTER = `---
title: 'CLI flags reference'
description: 'Complete reference of all Nitro node command-line flags with types, defaults, and descriptions'
sidebar_label: 'CLI flags reference'
user_story: 'As a node operator, I want a single page where I can look up any Nitro CLI flag'
content_type: 'reference'
author: gzeoneth
sme: gzeoneth
---
`;

/** Split a leading YAML frontmatter block off an MDX file. */
export function splitFrontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { frontmatter: '', body: source };
  return { frontmatter: match[0], body: source.slice(match[0].length) };
}

/** Escape the characters that would break out of a markdown table cell or an MDX expression. */
export function escapeCell(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

/** An empty default renders as a dash: pflag omits zero-value defaults, and so does the page. */
function formatDefault(value) {
  return value === '' ? '-' : `\`${escapeCell(value)}\``;
}

/** Group flags by their first dotted segment, namespaces in alphabetical order. */
export function groupByNamespace(flags) {
  const groups = new Map();
  for (const flag of flags) {
    const dot = flag.flag.indexOf('.');
    const namespace = dot === -1 ? flag.flag : flag.flag.slice(0, dot);
    if (!groups.has(namespace)) groups.set(namespace, []);
    groups.get(namespace).push(flag);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, nsFlags]) => ({ namespace, flags: nsFlags }));
}

/**
 * The generated region: the intro admonition, the usage examples, and one collapsible table per
 * namespace.
 *
 * @param {Array} flags already filtered and sorted
 * @param {object} options
 * @param {Record<string, {label: string, href: string}>} options.namespaceLinks
 * @param {{label: string, href: string}} options.defaultNamespaceLink
 * @param {string} options.nitroVersionTag
 */
export function renderGeneratedRegion(
  flags,
  { namespaceLinks, defaultNamespaceLink, nitroVersionTag },
) {
  const groups = groupByNamespace(flags);
  const lines = [];

  lines.push(`<VanillaAdmonition type="info" title="Auto-generated reference">

This page lists every CLI flag accepted by the Nitro node binary. For explanations, examples, and recommended configurations, see the curated guides:

- [Configuration system](/docs/run-a-node/nitro/configuration-system)
- [Docker and CLI binaries](/docs/run-a-node/nitro/docker-and-cli-binaries)
- [Node tuning and monitoring](/docs/run-a-node/nitro/node-tuning-and-monitoring)
- [DA tools reference](/docs/run-a-node/nitro/da-tools-reference)

**Total flags:** ${flags.length} across ${groups.length} namespaces, read from Nitro \`${nitroVersionTag}\`.

</VanillaAdmonition>

Pass flags on the command line with \`--\` prefix:

\`\`\`shell
nitro --http.addr=0.0.0.0 --http.port=8547 --node.feed.input.url=wss://arb1.arbitrum.io/feed
\`\`\`

Or set them in a JSON configuration file:

\`\`\`shell
nitro --conf.file=/path/to/config.json
\`\`\`
`);

  for (const group of groups) {
    const link = namespaceLinks[group.namespace] ?? defaultNamespaceLink;
    lines.push(`## ${group.namespace}`);
    lines.push('');
    lines.push(`Related guide: [${link.label}](${link.href})`);
    lines.push('');
    lines.push('<Accordions>');
    lines.push(`<Accordion title="${group.namespace} flags (${group.flags.length})">`);
    lines.push('');
    lines.push('| Flag | Type | Default | Description |');
    lines.push('| ---- | ---- | ------- | ----------- |');
    for (const flag of group.flags) {
      lines.push(
        `| \`${escapeCell(flag.flag)}\` | ${flag.type} | ${formatDefault(flag.default)} | ${escapeCell(flag.description)} |`,
      );
    }
    lines.push('');
    lines.push('</Accordion>');
    lines.push('</Accordions>');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Produce the full file content, keeping the existing frontmatter and any prose outside the
 * markers. `existing` is '' when the page does not exist yet.
 */
export function splicePage(existing, generated) {
  const { frontmatter, body } = splitFrontmatter(existing);
  const region = `${START_MARKER}\n\n${generated.trim()}\n\n${END_MARKER}`;

  const start = body.indexOf(START_MARKER);
  const end = body.indexOf(END_MARKER);
  if (start !== -1 && end !== -1 && end > start) {
    const head = body.slice(0, start);
    const tail = body.slice(end + END_MARKER.length);
    return `${frontmatter || SCAFFOLD_FRONTMATTER}${head}${region}${tail}`;
  }

  return `${frontmatter || SCAFFOLD_FRONTMATTER}\n${DO_NOT_EDIT}\n\n${region}\n`;
}
