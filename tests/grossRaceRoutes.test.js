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

const noVideo = { hasVideo: () => false };

function serve(t, feed, racePageVersion, video = noVideo) {
  const app = express();
  app.use(createGrossRaceRoutes({ feed, racePageVersion, video }));
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
    assert.deepEqual(await res.json(), { view, status: 'live', page: null, video: false });
  }
  assert.deepEqual(asked, ['teams', 'dispatchers']);
});

test('every answer names the build of the page, so an older screen reloads', async (t) => {
  const base = serve(t, { getRace: (view) => ({ view, status: 'loading', race: null }) }, () => 'GrossRacePage-aaaa.js');
  const res = await fetch(`${base}/api/gross-race?view=teams`);
  assert.equal((await res.json()).page, 'GrossRacePage-aaaa.js', 'even while the week is still loading');
});

test('only the teams\' board is told there is a video to play after the celebration', async (t) => {
  const base = serve(t, { getRace: (view) => ({ view }) }, undefined, { hasVideo: () => true });
  assert.equal((await (await fetch(`${base}/api/gross-race?view=teams`)).json()).video, true);
  assert.equal((await (await fetch(`${base}/api/gross-race?view=dispatchers`)).json()).video, false);
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
