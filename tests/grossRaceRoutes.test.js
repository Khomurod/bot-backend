'use strict';

/**
 * GET /api/gross-race: the public endpoint behind /dispatch and /dispatchteam.
 * It needs no sign-in, accepts only the two displays, is never cached by a
 * browser or proxy, and answers from the feed without waiting on Datatruck.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createGrossRaceRoutes } = require('../server/routes/grossRaceRoutes');

function serve(t, feed) {
  const app = express();
  app.use(createGrossRaceRoutes({ feed }));
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('each display gets its own race, with no sign-in and no caching', async (t) => {
  const asked = [];
  const base = serve(t, { getRace: (view) => { asked.push(view); return { view, status: 'live' }; } });

  for (const view of ['teams', 'dispatchers']) {
    const res = await fetch(`${base}/api/gross-race?view=${view}`);
    assert.equal(res.status, 200, view);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { view, status: 'live' });
  }
  assert.deepEqual(asked, ['teams', 'dispatchers']);
});

test('any other view is refused before the feed is asked', async (t) => {
  let asked = 0;
  const base = serve(t, { getRace: () => { asked += 1; return {}; } });
  for (const query of ['', '?view=all', '?view=Teams', '?view[]=teams']) {
    const res = await fetch(`${base}/api/gross-race${query}`);
    assert.equal(res.status, 400, query);
  }
  assert.equal(asked, 0);
});

test('a failure inside answers a plain 500', async (t) => {
  const error = console.error;
  console.error = () => {};
  t.after(() => { console.error = error; });
  const base = serve(t, { getRace: () => { throw new Error('boom at https://wenze.datatruck.io'); } });
  const res = await fetch(`${base}/api/gross-race?view=teams`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Failed to load the race' });
});
