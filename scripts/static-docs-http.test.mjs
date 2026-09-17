/** Run against `next start` after a production build; CI's Build job supplies the URL. */
import assert from 'node:assert/strict';
import test from 'node:test';

const baseUrl = process.env.STATIC_DOCS_TEST_URL;
const livePath = '/docs/run-a-node/start-here';
const archivePath = `${livePath}/v1`;
const liveMirror = `/llms.mdx${livePath}/content.md`;
const archiveMirror = `/llms.mdx${archivePath}/content.md`;
const archivedText = 'This archived guide targets the ArbOS 20 release series.';
const documentOnly = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const get = (path, options) => fetch(new URL(path, baseUrl), options);

test('built static docs routing', { skip: !baseUrl }, async (t) => {
  await t.test('HTML and negotiated markdown both vary on Accept', async () => {
    for (const accept of ['text/html', 'text/markdown']) {
      const response = await get(livePath, { headers: { accept } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('vary') ?? '', /(?:^|,\s*)Accept(?:,|$)/i, accept);
      assert.match(response.headers.get('cache-control') ?? '', /s-maxage=/);
      assert.match(response.headers.get('content-type') ?? '', new RegExp(accept));
      await response.text();
    }
  });

  await t.test('archives render their own body and their own markdown controls', async () => {
    const live = await get(livePath);
    assert.equal(live.status, 200);
    const liveHtml = await live.text();
    assert.ok(!documentOnly(liveHtml).includes(archivedText));
    assert.match(documentOnly(liveHtml), /Copy Markdown/);
    const archive = await get(archivePath);
    assert.equal(archive.status, 200);
    assert.match(archive.headers.get('cache-control') ?? '', /s-maxage=/);
    const html = await archive.text();
    const doc = documentOnly(html);
    assert.ok(doc.includes(archivedText));
    // The copy and view-as-markdown controls exist on an archive too (FS-2711) and must address
    // the archive's own mirror. Offering the live page's text under an archive URL is the mistake
    // `?v=` made before FS-2698.
    assert.match(doc, /Copy Markdown/);
    assert.ok(html.includes(archiveMirror));
    assert.ok(!html.includes(liveMirror));
    assert.ok(html.includes('content/_versions/v1/run-a-node/start-here.mdx'));
    assert.match(doc, /<meta name="robots" content="noindex, follow"/);
    assert.match(doc, /<link rel="canonical" href="[^"]+\/docs\/run-a-node\/start-here"/);
  });

  await t.test('legacy versions redirect and retain unrelated query parameters', async () => {
    for (const [source, destination] of [
      [`${livePath}?v=v1`, archivePath],
      [`${livePath}?v=latest`, livePath],
      [`${livePath}?v=unknown`, livePath],
      // The `.md` form used to fall through and answer with Latest's text. It carries the suffix
      // across now that an archive has a markdown mirror of its own (FS-2711).
      [`${livePath}.md?v=v1`, `${archivePath}.md`],
      [`${livePath}.md?v=unknown`, `${livePath}.md`],
    ]) {
      const [path, query] = source.split('?');
      const response = await get(`${path}?${query}&ref=test`, { redirect: 'manual' });
      assert.equal(response.status, 308, source);
      const target = new URL(response.headers.get('location'), baseUrl);
      assert.equal(target.pathname, destination, source);
      assert.equal(target.search, '?ref=test', source);
      await response.text();
    }
  });

  await t.test('unknown docs and prototype-named slugs serve visible 404s', async () => {
    // FS-2688. `dynamicParams = false` is what makes these land on the prerendered `/_not-found`
    // entry instead of the empty `__next_error__` shell a mid-render `notFound()` produces. The
    // copy has to be in the document with scripts stripped: a *200* page carries it too, inside the
    // router's prefetched flight payload.
    for (const path of [
      '/docs/does-not-exist',
      '/docs/does/not/exist/deep',
      `${livePath}/v99`,
      '/docs/constructor?v=v1',
      '/docs/__proto__?v=v1',
    ]) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      const doc = documentOnly(await response.text());
      assert.match(doc, /Start somewhere else/);
      assert.doesNotMatch(doc, /__next_error__/);
    }
  });

  await t.test('every markdown shape of an archive serves the archive, not Latest', async () => {
    const live = await get(`${livePath}.md`);
    assert.equal(live.status, 200);
    const liveText = await live.text();
    assert.ok(!liveText.includes(archivedText));

    // The suffix, the mirror, and content negotiation: the same three shapes a live page has.
    const requests = [
      [`${archivePath}.md`, undefined],
      [archiveMirror, undefined],
      [archivePath, { accept: 'text/markdown' }],
      // A legacy `?v=` link keeps working, and now reaches the archive's text rather than Latest's.
      [`${livePath}.md?v=v1`, undefined],
      [`${livePath}?v=v1`, { accept: 'text/markdown' }],
    ];
    for (const [path, headers] of requests) {
      const response = await get(path, headers ? { headers } : undefined);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') ?? '', /text\/markdown/, path);
      const text = await response.text();
      assert.ok(text.includes(archivedText), path);
      assert.notEqual(text, liveText, path);
      assert.match(text.split('\n')[0], new RegExp(`\\(${archivePath}\\)$`), path);
    }

    // Archives are noindex with a canonical to the live page. A markdown body can carry neither
    // tag, so the mirror states it in the only place it can. Live markdown stays header-free.
    const mirror = await get(archiveMirror);
    assert.match(mirror.headers.get('x-robots-tag') ?? '', /noindex/);
    await mirror.text();
    const liveMirrorResponse = await get(liveMirror);
    assert.equal(liveMirrorResponse.headers.get('x-robots-tag'), null);
    await liveMirrorResponse.text();
  });

  await t.test('a version id that names no archive 404s rather than serving Latest', async () => {
    for (const path of [
      `${livePath}/v99.md`,
      `/llms.mdx${livePath}/v99/content.md`,
      // A page with no archives at all; `/docs/chain-info` is not in VERSIONED.
      '/docs/chain-info/v1.md',
      '/llms.mdx/docs/chain-info/v1/content.md',
    ]) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      await response.text();
    }
    const negotiated = await get(`${livePath}/v99`, { headers: { accept: 'text/markdown' } });
    assert.equal(negotiated.status, 404);
    await negotiated.text();
  });

  await t.test('a prototype-named slug 404s on every markdown shape', async () => {
    // The registry is an object literal, so `VERSIONED['constructor']` resolved up the prototype
    // chain to a function and the resolver's `?.find` threw rather than short-circuiting: an
    // unhandled 500 on a URL anyone, an ordinary crawler included, can send. The HTML shape was
    // never affected, because that route carries `dynamicParams = false`. The markdown route
    // carries it now too, and `versionSources` guards the registry lookup itself.
    for (const path of [
      '/docs/constructor/v1.md',
      '/docs/toString/v1.md',
      '/llms.mdx/docs/constructor/v1/content.md',
      '/llms.mdx/docs/toString/v1/content.md',
      '/llms.mdx/docs/__proto__/v1/content.md',
      '/llms.mdx/docs/valueOf/anything/content.md',
    ]) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      await response.text();
    }
    const negotiated = await get('/docs/constructor/v1', { headers: { accept: 'text/markdown' } });
    assert.equal(negotiated.status, 404);
    await negotiated.text();
  });

  await t.test('the docs 404 is the same response as the root 404', async () => {
    // Both are the one prerendered `/_not-found` output, so they are byte identical. A divergence
    // means `/docs/*` has stopped falling through to it, which is how FS-2688 regresses.
    const [root, docs] = await Promise.all([get('/does-not-exist'), get('/docs/does-not-exist')]);
    assert.equal(root.status, 404);
    assert.equal(docs.status, 404);
    assert.equal(await docs.text(), await root.text());
    for (const response of [root, docs]) {
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    }
  });

  await t.test('archives stay out of discovery and generated image routes', async () => {
    for (const path of ['/sitemap.xml', '/llms.txt', '/llms-full.txt']) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.ok(!(await response.text()).includes(archivePath), path);
    }
    // The markdown mirror is the one archive URL that exists on purpose (FS-2711); an archive
    // still gets no OG image of its own, and none of the three discovery files above names one.
    const og = await get(`/og${archivePath}/image.png`);
    assert.equal(og.status, 404);
    await og.text();
  });
});

test('well-known MCP discovery card', { skip: !baseUrl }, async (t) => {
  const cardPath = '/.well-known/mcp/server-card.json';

  await t.test('serves the card as JSON, whatever the client will accept', async () => {
    // `/.well-known/` is on the proxy's bypass list. A client discovering the MCP server sends
    // whatever Accept header it likes, and every one of them must get the file on disk rather than
    // a negotiated markdown body, so both headers are asserted here.
    for (const accept of ['application/json', 'text/markdown']) {
      const response = await get(cardPath, { headers: { accept } });
      assert.equal(response.status, 200, accept);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/, accept);
      const card = JSON.parse(await response.text());
      assert.equal(card.transport.type, 'streamable-http');
      assert.equal(card.transport.endpoint, 'https://mcp.inkeep.com/offchainlabs/mcp');
    }
  });

  await t.test('a well-known path with no file behind it is a 404', async () => {
    const response = await get('/.well-known/nope.json');
    assert.equal(response.status, 404);
    await response.text();
  });

  await t.test('robots.txt does not disallow the well-known tree', async () => {
    const response = await get('/robots.txt');
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /Disallow:\s*\/\.well-known/i);
  });
});

test('home page metadata', { skip: !baseUrl }, async (t) => {
  // FS-2713. The site root shipped with no <title>, no description, no canonical and no social
  // tags at all, while every docs page had the lot. These assertions run against the built HTML
  // because that is the only place the answer lives: `types:check` proves the Metadata object
  // compiles, not that Next emitted a tag from it.
  const head = async (path) => {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    return await response.text();
  };
  const tag = (html, pattern) => html.match(pattern)?.[1];

  const title = (html) => tag(html, /<title>([^<]*)<\/title>/);
  const meta = (html, name) =>
    tag(html, new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`));

  await t.test('the root carries a title, description, canonical and social tags', async () => {
    const html = await head('/');
    assert.equal(title(html), 'Arbitrum documentation');
    assert.match(meta(html, 'description') ?? '', /^Arbitrum is the finance-native platform/);
    assert.match(tag(html, /<link rel="canonical" href="([^"]*)"/) ?? '', /^https?:\/\/[^/]+\/?$/);
    assert.equal(meta(html, 'og:type'), 'website');
    assert.equal(meta(html, 'og:title'), 'Arbitrum documentation');
    assert.equal(meta(html, 'og:description'), meta(html, 'description'));
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image');
    assert.equal(meta(html, 'twitter:site'), '@arbitrum');
    assert.equal(meta(html, 'twitter:title'), 'Arbitrum documentation');
  });

  await t.test('the social card the root names is a real 1200x630 PNG', async () => {
    // `app/(home)/opengraph-image.tsx` is served from `/opengraph-image-<hash>`, where the suffix
    // is Next's and not ours. Following the URL out of the document is the only way to assert the
    // tag points at something rather than at a 404. It also proves the route answers with a real
    // PNG even under a markdown-preferring Accept header, though that is not because of the
    // `/opengraph-image` proxy bypass entry: both negotiation patterns in proxy.ts are anchored at
    // `/docs`, so this path never reaches them regardless of the bypass (see the comment there).
    const html = await head('/');
    const image = meta(html, 'og:image');
    assert.ok(image, 'no og:image on /');
    assert.equal(meta(html, 'twitter:image'), image);
    assert.equal(meta(html, 'og:image:width'), '1200');
    assert.equal(meta(html, 'og:image:height'), '630');

    const url = new URL(image);
    const response = await get(`${url.pathname}${url.search}`, {
      headers: { accept: 'text/markdown' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /image\/png/);
    assert.ok((await response.arrayBuffer()).byteLength > 1024);
  });

  await t.test('the root and the docs landing page do not share a title', async () => {
    // `/` and `/docs` are two separately indexable portal pages. Giving them one title would make
    // each compete with the other for the same query, which is why the root does not simply reuse
    // `content/docs/index.mdx`'s "Arbitrum docs". See lib/shared.ts.
    const [root, docs] = await Promise.all([head('/'), head('/docs')]);
    assert.notEqual(title(root), title(docs));
    assert.notEqual(meta(root, 'description'), meta(docs, 'description'));
  });
});
