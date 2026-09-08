'use strict';

/**
 * The removed features' old page URLs, over HTTP.
 *
 * `/trailers`, `/questions`, `/answers` and `/qbq` are in browser bookmarks, in
 * chat history and on printed material. They used to resolve to the admin SPA
 * shell, which would now render an empty section for a feature that no longer
 * exists — so they answer 410 Gone with a short explanation instead.
 *
 * The important assertions are the ones about what this router must NOT catch:
 * it is mounted just before the SPA catch-all, and a prefix that is too greedy
 * would swallow `/api/questions` (the driver survey feature, which survives and
 * has nothing to do with the removed SOS page at `/questions`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createRetiredRoutes, RETIRED_PAGE_PATHS } = require('../server/routes/retiredRoutes');

async function withServer(fn) {
  const app = express();
  app.use(createRetiredRoutes());
  // Stand-ins for the neighbours this router must not swallow.
  app.get('/api/questions', (req, res) => res.json({ survey: true }));
  app.get('/api/questions/:id', (req, res) => res.json({ survey: req.params.id }));
  app.get('/answersheet', (req, res) => res.type('text').send('unrelated'));
  app.get(['/admin', '/admin/*'], (req, res) => res.type('html').send('<html>spa</html>'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('every removed page URL answers 410 Gone with an explanation', async () => {
  await withServer(async (base) => {
    for (const url of [
      '/trailers', '/trailers/', '/trailers/rentals', '/trailers/money/invoices/7',
      '/questions', '/questions/test', '/answers', '/answers/test',
      '/qbq', '/qbq/remote', '/qbq/assets/qbq-edit.js',
    ]) {
      const res = await fetch(`${base}${url}`);
      assert.equal(res.status, 410, `${url} must answer 410 Gone`);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      const body = await res.text();
      assert.match(body, /This feature has been removed/i, `${url} must say what happened`);
      assert.match(body, /noindex/, 'and ask crawlers not to index it');
      assert.match(body, /href="\/admin"/, 'and offer somewhere to go');
    }
  });
});

test('a stale form post gets the same explanation, not a bare 404', async () => {
  await withServer(async (base) => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/questions`, { method });
      assert.equal(res.status, 410, `${method} /questions must answer 410`);
    }
  });
});

test('it does not swallow the surviving driver-survey API', async () => {
  // /questions (the removed SOS page) and /api/questions (the Telegram driver
  // survey) are different features that share a word. Confusing them would
  // take down surveys.
  await withServer(async (base) => {
    const list = await fetch(`${base}/api/questions`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { survey: true });

    const one = await fetch(`${base}/api/questions/42`);
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { survey: '42' });
  });
});

test('it matches whole path segments, not prefixes', async () => {
  await withServer(async (base) => {
    // `/answersheet` starts with "/answers" but is a different path.
    const res = await fetch(`${base}/answersheet`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'unrelated');
  });
});

test('it leaves the admin SPA and unknown paths alone', async () => {
  await withServer(async (base) => {
    assert.match(await (await fetch(`${base}/admin`)).text(), /spa/);
    assert.match(await (await fetch(`${base}/admin/users`)).text(), /spa/);
    // An unrelated unknown path is still a plain 404, not a "feature removed".
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('the path list is explicit — no bare prefixes that could grow greedy', () => {
  for (const p of RETIRED_PAGE_PATHS) {
    assert.match(p, /^\/[a-z]+(\/\*)?$/, `${p} must be an exact path or a one-level wildcard`);
  }
  assert.ok(RETIRED_PAGE_PATHS.includes('/trailers'));
  assert.ok(RETIRED_PAGE_PATHS.includes('/qbq/*'));
  // /api is never listed: a JSON client should get a 404, not an HTML page.
  assert.ok(!RETIRED_PAGE_PATHS.some((p) => p.startsWith('/api')), 'API paths must 404, not 410');
});
