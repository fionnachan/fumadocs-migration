/** Run against `next start` after a production build; CI's Build job supplies the URL. */
import assert from 'node:assert/strict';
import test from 'node:test';

const baseUrl = process.env.STATIC_DOCS_TEST_URL;
const livePath = '/docs/run-a-node/start-here';
const archivePath = `${livePath}/v1`;
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

  await t.test('archives render their own body and hide live markdown controls', async () => {
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
    assert.doesNotMatch(doc, /Copy Markdown/);
    assert.ok(!html.includes('/llms.mdx/docs/run-a-node/start-here/content.md'));
    assert.ok(html.includes('content/_versions/v1/run-a-node/start-here.mdx'));
    assert.match(doc, /<meta name="robots" content="noindex, follow"/);
    assert.match(doc, /<link rel="canonical" href="[^"]+\/docs\/run-a-node\/start-here"/);
  });

  await t.test('legacy versions redirect and retain unrelated query parameters', async () => {
    for (const [version, destination] of [
      ['v1', archivePath],
      ['latest', livePath],
      ['unknown', livePath],
    ]) {
      const response = await get(`${livePath}?v=${version}&ref=test`, { redirect: 'manual' });
      assert.equal(response.status, 308);
      const target = new URL(response.headers.get('location'), baseUrl);
      assert.equal(target.pathname, destination);
      assert.equal(target.search, '?ref=test');
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

  await t.test(
    'archive markdown stays unavailable, including legacy negotiated requests',
    async () => {
      for (const path of [archivePath, `${livePath}?v=v1`, `${archivePath}.md`]) {
        const response = await get(path, { headers: { accept: 'text/markdown' } });
        assert.equal(response.status, 404, path);
        await response.text();
      }
      const live = await get(`${livePath}.md`);
      assert.equal(live.status, 200);
      assert.ok(!(await live.text()).includes(archivedText));
    },
  );

  await t.test('archives stay out of discovery and generated image routes', async () => {
    for (const path of ['/sitemap.xml', '/llms.txt', '/llms-full.txt']) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.ok(!(await response.text()).includes(archivePath), path);
    }
    for (const path of [`/og${archivePath}/image.png`, `/llms.mdx${archivePath}/content.md`]) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      await response.text();
    }
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
