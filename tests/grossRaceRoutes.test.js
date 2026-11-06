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
const { createBirthdayBoard } = require('../services/grossRace/birthdays');

const noVideo = { hasVideo: () => false };

function serve(t, feed, racePageVersion, video = noVideo, birthdays = createBirthdayBoard()) {
  const app = express();
  app.use(createGrossRaceRoutes({ feed, racePageVersion, video, birthdays }));
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
    assert.deepEqual(await res.json(), { view, status: 'live', page: null, video: false, birthdays: [] });
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

test('today\'s birthdays on both boards: names, an American name, a truck — nothing else', async (t) => {
  const board = createBirthdayBoard();
  board.noteBirthday({ kind: 'employee', id: 7, name: 'Testbek', subtitle: 'Tom', card: Buffer.from('jpeg'), telegram_username: 'tg_handle_x' });
  board.noteBirthday({ kind: 'driver', id: 42, name: 'John Smith', truck: '1109', telegram_user_id: '987654321' });
  const base = serve(t, { getRace: (view) => ({ view }) }, undefined, noVideo, board);
  for (const view of ['teams', 'dispatchers']) {
    const body = await (await fetch(`${base}/api/gross-race?view=${view}`)).json();
    assert.deepEqual(body.birthdays.map((b) => [b.kind, b.name, b.subtitle, b.truck]), [
      ['employee', 'Testbek', 'Tom', null], ['driver', 'John Smith', null, '1109'],
    ]);
    assert.doesNotMatch(JSON.stringify(body), /tg_handle_x|987654321/);
  }
});

test('the card route serves today\'s employee card, never cached, and 404 for anything else', async (t) => {
  let at = Date.parse('2026-11-06T19:00:00Z');
  const board = createBirthdayBoard({ now: () => at });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
  board.noteBirthday({ kind: 'employee', id: 7, name: 'Testbek', card: jpeg });
  board.noteBirthday({ kind: 'driver', id: 42, name: 'John Smith', truck: '1109' });
  const base = serve(t, { getRace: (view) => ({ view }) }, undefined, noVideo, board);
  const { card } = (await (await fetch(`${base}/api/gross-race?view=teams`)).json()).birthdays[0];

  const res = await fetch(`${base}${card}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg);

  for (const key of ['driver-42-2026-11-06', 'employee-8-2026-11-06', 'employee-7-2026-11-05', '..%2F..%2Fpackage.json']) {
    const other = await fetch(`${base}/api/gross-race/birthday-card/${key}`);
    assert.equal(other.status, 404, key);
    assert.equal(other.headers.get('cache-control'), 'no-store');
  }
  at += 24 * 60 * 60 * 1000; // a day later: gone
  assert.equal((await fetch(`${base}${card}`)).status, 404);
});
