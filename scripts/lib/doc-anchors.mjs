import { createProcessor } from '@mdx-js/mdx';
import { frontmatter } from 'fumadocs-core/content/md/frontmatter';
import { applyMdxPreset, remarkInclude } from 'fumadocs-mdx/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { visit } from 'unist-util-visit';
import { VFile } from 'vfile';

import { mdxOptions } from '../../lib/mdx-options.mjs';

/** Compile with the site's preset, plus the include pass Fumadocs MDX adds before it. */
export async function createAnchorCompiler(repoRoot) {
  const options = await applyMdxPreset(mdxOptions)('bundler');
  const processors = new Map();
  const sources = new Map();

  function source(filePath) {
    if (!sources.has(filePath)) {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = frontmatter(raw);
      sources.set(filePath, {
        ...parsed,
        lineOffset: raw.slice(0, raw.length - parsed.content.length).split('\n').length - 1,
      });
    }
    return sources.get(filePath);
  }

  // The include plugin calls this parser for every partial, including nested and selected
  // sections. Preserve its original location before splicing it into the containing page.
  function parser(format) {
    return {
      parse(file) {
        const tree = processor(format).parse(file);
        const { lineOffset } = source(file.path);
        visit(tree, (node) => {
          node.data ??= {};
          node.data.anchorSource = {
            file: file.path,
            rel: path.relative(repoRoot, file.path).split(path.sep).join('/'),
            line: (node.position?.start.line ?? 1) + lineOffset,
          };
        });
        return tree;
      },
    };
  }

  function collectLinks() {
    return (tree, file) => {
      const definitions = new Map();
      visit(tree, 'definition', (node) => {
        // Markdown resolves duplicate reference definitions to the first occurrence.
        if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
      });
      const links = [];
      visit(tree, (node) => {
        let url;
        if (node.type === 'link') url = node.url;
        if (node.type === 'linkReference') url = definitions.get(node.identifier);
        if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
          url = node.attributes.find((attr) => ['href', 'to'].includes(attr.name))?.value;
        }
        if (typeof url === 'string' && url.includes('#')) {
          links.push({ ...node.data.anchorSource, url });
        }
      });
      file.data.anchorLinks = links;
    };
  }

  function collectIds() {
    return (tree, file) => {
      const ids = new Set();
      visit(tree, (node) => {
        if (node.type === 'element' && typeof node.properties.id === 'string') {
          ids.add(node.properties.id);
        }
        // A component's `id` prop (e.g. <Term id="gas">) need not be a DOM id.
        if (/^[a-z]/.test(node.name ?? '') && node.attributes) {
          const id = node.attributes.find((attr) => attr.name === 'id')?.value;
          if (typeof id === 'string') ids.add(id);
        }
      });
      file.data.anchorIds = ids;
    };
  }

  function processor(format) {
    if (!processors.has(format)) {
      processors.set(
        format,
        createProcessor({
          ...options,
          format,
          remarkPlugins: [remarkInclude, ...options.remarkPlugins, collectLinks],
          rehypePlugins: [...options.rehypePlugins, collectIds],
        }),
      );
    }
    return processors.get(format);
  }

  return async (filePath) => {
    const parsed = source(filePath);
    const format = filePath.endsWith('.mdx') ? 'mdx' : 'md';
    const file = new VFile({
      path: filePath,
      cwd: repoRoot,
      value: parsed.content,
      data: { frontmatter: parsed.data, _getProcessor: parser },
    });
    // Run the real remark -> rehype transforms; JavaScript output is unnecessary for checking.
    await processor(format).run(parser(format).parse(file), file);
    return { ids: file.data.anchorIds, links: file.data.anchorLinks };
  };
}

/** Validate local fragments against compiled ids, in each including page's URL context. */
export async function findBrokenAnchors(index) {
  const compile = await createAnchorCompiler(index.repoRoot);
  const pages = new Map();
  for (const file of index.files) {
    if (!file.url) continue;
    try {
      pages.set(file.url, await compile(file.abs));
    } catch (error) {
      throw new Error(`Cannot validate anchors in ${file.rel}: ${error.message}`, { cause: error });
    }
  }

  const broken = [];
  const origin = 'https://docs.invalid';
  for (const [pageUrl, { links }] of pages) {
    for (const link of links) {
      // Absolute and scheme-relative links belong to the external-link policy.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.url)) continue;
      const url = new URL(link.url, origin + pageUrl);
      if (!url.hash || url.hash === '#') continue;
      const target = pages.get(url.pathname.replace(/\/$/, '') || '/');
      // Missing pages remain the responsibility of the existing path checker; assets and
      // non-doc routes do not have MDX heading ids.
      if (!target) continue;
      let id;
      try {
        id = decodeURIComponent(url.hash.slice(1));
      } catch {
        id = url.hash.slice(1);
      }
      // Chromium text fragments can follow a normal element fragment, or stand alone.
      id = id.split(':~:')[0];
      if (!id || target.ids.has(id) || id.toLowerCase() === 'top') continue;
      broken.push({ ...link, page: pageUrl, reason: 'missing anchor' });
    }
  }
  return broken;
}
