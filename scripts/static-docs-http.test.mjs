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
    for (const path of [
      '/docs/does-not-exist',
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
