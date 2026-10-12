'use strict';

/**
 * Gross Grand Prix feed: what the race costs Datatruck, and what a screen sees.
 *
 * Datatruck allows 20 requests a minute and the rest of the app shares them,
 * so the feed reads the week whole at most every 20 minutes, only modified
 * orders in between, at most once a minute, and only when a screen asks. A
 * screen never waits on a read, and never sees the error itself or the token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGrossRaceFeed } = require('../services/grossRace/feed');

const MINUTE = 60_000;
const START = Date.parse('2026-10-14T18:00:00Z'); // a Wednesday

function order(id, { creator = 'Ann Example', pay = 5000, status = 'delivered' } = {}) {
  return {
    id, dispatcher__full_name: "Falcon's Team", created_by__full_name: creator, load_pay: String(pay),
    total_miles: '1000', status, delivery_time: '2026-10-13T15:00:00Z',
    created_datetime: '2026-10-12T14:00:00Z', pickup_time: '2026-10-12T20:00:00Z',
    trip: { driver__full_name: `Driver ${id}`, team_driver__full_name: '' },
  };
}

function harness({ configured = true } = {}) {
  let clock = START;
  const calls = [];
  const warnings = [];
  const replies = [];
  const api = {
    isConfigured: () => configured,
    maskToken: (text) => String(text).split('SECRET-TOKEN').join('***'),
    async fetchOrdersByDeliveryDate(startIso, endIso, opts) {
      calls.push({ startIso, endIso, ...opts });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply || [];
    },
  };
  const feed = createGrossRaceFeed({ api, now: () => clock, log: { warn: (...args) => warnings.push(args.join(' ')) } });
  return {
    feed, calls, warnings,
    reply: (value) => replies.push(value),
    advance: (ms) => { clock += ms; },
  };
}

test('the first screen gets "loading" at once; the week is read whole in the background', async () => {
  const h = harness();
  h.reply([order(1), order(2, { pay: 7000 })]);

  const first = h.feed.getRace('dispatchers');
  assert.equal(first.status, 'loading');
  assert.equal(first.race, null);
  assert.equal(first.week.label, 'Oct 12–18');

  await h.feed.settled();
  const race = h.feed.getRace('dispatchers');
  assert.equal(race.status, 'live');
  assert.equal(race.race.racers[0].gross, 12000);
  assert.equal(h.calls.length, 1, 'the second ask, a moment later, starts no read');
  assert.deepEqual(h.calls[0], {
    startIso: '2026-10-11T17:00:00.000Z', endIso: '2026-10-19T04:59:59.999Z', modifiedAfterIso: null,
  });
  assert.equal(race.targets, null, 'the dispatchers race has no target');
  assert.deepEqual(h.feed.getRace('teams').targets, { solo: 15000, team: 20000 });
  assert.equal(h.feed.getRace('teams').race.racers[0].gross, 12000, 'the same loads, credited to the team');
});

test('a load created or picked up before Monday is read but not counted', async () => {
  const h = harness();
  h.reply([order(1), { ...order(2, { pay: 9000 }), created_datetime: '2026-10-08T14:00:00Z', pickup_time: '2026-10-09T14:00:00Z' }]);
  h.feed.getRace('teams');
  await h.feed.settled();
  assert.equal(h.feed.getRace('teams').race.racers[0].gross, 5000);
  assert.equal(h.feed.getRace('dispatchers').race.racers[0].gross, 5000);
});

test('screens polling together cost one read a minute, and only modified orders between full reads', async () => {
  const h = harness();
  h.reply([order(1), order(2)]);
  h.feed.getRace('teams');
  h.feed.getRace('dispatchers');
  await h.feed.settled();
  assert.equal(h.calls.length, 1, 'two screens, one read');

  h.advance(30_000);
  h.feed.getRace('dispatchers');
  assert.equal(h.calls.length, 1, 'not within the minute');

  h.advance(31_000);
  h.reply([order(2, { status: 'Cancelled' }), order(3, { pay: 9000 })]);
  h.feed.getRace('dispatchers');
  await h.feed.settled();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].modifiedAfterIso, new Date(START - 3 * MINUTE).toISOString(),
    'changed since the last read began, with three minutes of overlap');
  const racer = h.feed.getRace('dispatchers').race.racers[0];
  assert.equal(racer.loads, 2, 'the cancelled order left the race, the new one joined');
  assert.equal(racer.gross, 14000);

  h.advance(20 * MINUTE);
  h.reply([order(9)]);
  h.feed.getRace('dispatchers');
  await h.feed.settled();
  assert.equal(h.calls.at(-1).modifiedAfterIso, null, 'every 20 minutes the week is read whole again');
  assert.equal(h.feed.getRace('dispatchers').race.racers[0].loads, 1, 'and replaces what was held');
});

test('a failed read keeps the race on screen, says so in plain words, and never echoes the error', async () => {
  const h = harness();
  h.reply([order(1)]);
  h.feed.getRace('dispatchers');
  await h.feed.settled();

  h.advance(MINUTE);
  const failure = Object.assign(new Error('Datatruck API 401: bad token SECRET-TOKEN at https://wenze.datatruck.io'), { status: 401 });
  h.reply(failure);
  h.feed.getRace('dispatchers');
  await h.feed.settled();

  const race = h.feed.getRace('dispatchers');
  assert.equal(race.status, 'stale');
  assert.equal(race.error, 'Datatruck rejected the token');
  assert.equal(race.race.racers.length, 1, 'the last good standings stay');
  assert.ok(!JSON.stringify(race).includes('SECRET-TOKEN') && !JSON.stringify(race).includes('datatruck.io'));
  assert.ok(h.warnings[0].includes('***') && !h.warnings[0].includes('SECRET-TOKEN'), 'the log is masked too');

  h.advance(MINUTE);
  h.reply([order(1), order(2)]);
  h.feed.getRace('dispatchers');
  await h.feed.settled();
  assert.equal(h.calls.at(-1).modifiedAfterIso, new Date(START - 3 * MINUTE).toISOString(),
    'the next read starts from the last one that worked');
  assert.equal(h.feed.getRace('dispatchers').status, 'live');
});

test('a new week starts empty and reads the new week whole', async () => {
  const h = harness();
  h.reply([order(1)]);
  h.feed.getRace('dispatchers');
  await h.feed.settled();

  h.advance(5 * 24 * 60 * MINUTE); // the next Monday
  h.reply([]);
  const turnover = h.feed.getRace('dispatchers');
  assert.equal(turnover.status, 'loading', "last week's standings are not shown as this week's");
  assert.equal(turnover.week.label, 'Oct 19–25');
  await h.feed.settled();
  assert.equal(h.calls.at(-1).modifiedAfterIso, null);
  assert.equal(h.calls.at(-1).startIso, '2026-10-18T17:00:00.000Z', "twelve hours early, for Monday's date-only DEL dates");
});

test('without a Datatruck token the screens say so and nothing is read', () => {
  const h = harness({ configured: false });
  const race = h.feed.getRace('teams');
  assert.equal(race.status, 'error');
  assert.equal(race.error, 'Datatruck is not connected');
  assert.equal(h.calls.length, 0);
});
