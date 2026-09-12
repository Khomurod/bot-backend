'use strict';

/**
 * One driver, one picture, and where that picture disagrees with itself.
 *
 * THE RULE THIS FILE GUARDS: a contradiction is REPORTED, never resolved. When
 * two features disagree about a driver, the answer is not the more recent one,
 * the more confident one, or the one with more rows — it is that a person must
 * look. Picking a side here is the same mistake as picking a side between two
 * sources, with worse consequences, because this one is about a named human.
 *
 * And the one that earns the whole module: QUIET IS NOT GONE. A retention
 * notice about a driver who drove 400 miles yesterday is not a retention
 * signal, it is a broken feed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { describeContext, findContradictions, coverage } = require('../lib/drivers/context');

const NOW = '2026-09-11T12:00:00Z';
const hoursAgo = (n) => new Date(Date.parse(NOW) - n * 3600000).toISOString();

// ── an unreadable section is not an empty one ───────────────────────────────

test('A SECTION THAT COULD NOT BE READ IS known:false, NOT EMPTY', () => {
  const ctx = describeContext({ personId: 1, safety: null });
  assert.equal(ctx.safety.known, false);
  // "this driver has no safety events" and "we could not read the safety
  // table" produce identical empty objects, and only one is a reason to relax.
  const withNone = describeContext({ personId: 1, safety: { events: 0 } });
  assert.equal(withNone.safety.known, true);
  assert.equal(withNone.safety.events, 0);
});

test('every section is present even when nothing was read', () => {
  const ctx = describeContext({});
  for (const k of ['identity', 'homeTime', 'loads', 'fuel', 'safety', 'retention']) {
    assert.equal(ctx[k].known, false, `${k} is accounted for`);
  }
});

test('coverage says how much of the picture we have', () => {
  const ctx = describeContext({ personId: 1, homeTime: { state: 'road' }, loads: { movingPhase: null } });
  const c = coverage(ctx);
  assert.equal(c.known, 2);
  assert.equal(c.total, 6);
  assert.deepEqual(c.missing.sort(), ['fuel', 'identity', 'retention', 'safety']);
  // Three sections unreadable and no contradictions found is not a clean bill
  // of health, it is a mostly-blank page — and a caller needs to tell those
  // apart.
});

// ── quiet is not gone ───────────────────────────────────────────────────────

test('GONE QUIET WHILE PLAINLY WORKING IS A BROKEN FEED, NOT A RETENTION SIGNAL', () => {
  const ctx = describeContext({
    personId: 1,
    retention: { goneQuiet: true, goneQuietSince: hoursAgo(200) },
    fuel: { newestReadingAt: hoursAgo(4) },
    safety: { newestEventAt: hoursAgo(6) },
  });
  const found = findContradictions(ctx, { now: NOW });
  const quiet = found.find((c) => c.kind === 'quiet_but_active');
  assert.ok(quiet, 'a driver who was driving this morning has not gone quiet');
  assert.match(quiet.summary, /source that stopped reporting/);
  assert.match(quiet.summary, /fuel reading 4h ago/);
  assert.match(quiet.summary, /safety event 6h ago/);
});

test('gone quiet with nothing else moving is NOT contradicted — it may be real', () => {
  const ctx = describeContext({
    personId: 1,
    retention: { goneQuiet: true },
    fuel: { newestReadingAt: hoursAgo(400) },
    safety: { newestEventAt: null },
  });
  assert.deepEqual(findContradictions(ctx, { now: NOW }), [],
    'the module reports disagreement, and silence everywhere is agreement');
});

test('activity older than the window does not rescue a quiet driver', () => {
  const ctx = describeContext({
    personId: 1,
    retention: { goneQuiet: true },
    fuel: { newestReadingAt: hoursAgo(50) },
  });
  assert.deepEqual(findContradictions(ctx, { now: NOW, activeWithinMinutes: 720 }), []);
});

test('an unreadable fuel section cannot be mistaken for activity', () => {
  const ctx = describeContext({ personId: 1, retention: { goneQuiet: true }, fuel: null });
  assert.deepEqual(findContradictions(ctx, { now: NOW }), []);
});

// ── at home and simultaneously working ──────────────────────────────────────

test('at home while the board has them delivering is a contradiction', () => {
  const ctx = describeContext({
    personId: 1,
    homeTime: { state: 'home', stateSince: hoursAgo(72) },
    loads: { movingPhase: 'in_transit', orderId: 'A1' },
  });
  const found = findContradictions(ctx, { now: NOW });
  const c = found.find((x) => x.kind === 'home_while_working');
  assert.ok(c);
  assert.deepEqual(c.sides, ['home_time', 'loads']);
  assert.match(c.summary, /in_transit/,
    'the useful sentence names both sides, not "something is wrong with driver 12"');
});

test('at home with no load moving is ordinary', () => {
  const ctx = describeContext({
    personId: 1, homeTime: { state: 'home' }, loads: { movingPhase: null },
  });
  assert.deepEqual(findContradictions(ctx, { now: NOW }), []);
});

test('on the road while delivering is exactly what should happen', () => {
  const ctx = describeContext({
    personId: 1, homeTime: { state: 'road' }, loads: { movingPhase: 'in_transit' },
  });
  assert.deepEqual(findContradictions(ctx, { now: NOW }), []);
});

// ── two trucks at once ──────────────────────────────────────────────────────

test('two open units for one person is reported, never picked between', () => {
  const ctx = describeContext({ personId: 1, identity: { openUnits: ['123', '456'] } });
  const found = findContradictions(ctx, { now: NOW });
  const c = found.find((x) => x.kind === 'two_open_units');
  assert.ok(c);
  assert.deepEqual(c.evidence.units, ['123', '456']);
});

test('one open unit is not a contradiction', () => {
  const ctx = describeContext({ personId: 1, identity: { openUnits: ['123'] } });
  assert.deepEqual(findContradictions(ctx, { now: NOW }), []);
});

// ── the rule ────────────────────────────────────────────────────────────────

test('NOTHING HERE RESOLVES A CONTRADICTION — it only describes one', () => {
  const ctx = describeContext({
    personId: 1,
    homeTime: { state: 'home', stateSince: hoursAgo(72) },
    loads: { movingPhase: 'in_transit' },
    retention: { goneQuiet: true },
    fuel: { newestReadingAt: hoursAgo(2) },
    identity: { openUnits: ['1', '2'] },
  });
  const found = findContradictions(ctx, { now: NOW });
  assert.equal(found.length, 3, 'all three are reported');
  for (const c of found) {
    // No winner, no correction, no proposed value — a description and its
    // evidence, which is all a person needs and all this may produce.
    assert.deepEqual(Object.keys(c).sort(), ['evidence', 'kind', 'sides', 'summary']);
    for (const v of Object.values(c)) assert.notEqual(typeof v, 'function');
  }
});

test('an empty context contradicts nothing rather than crashing', () => {
  assert.deepEqual(findContradictions(describeContext({}), { now: NOW }), []);
  assert.deepEqual(findContradictions(null, { now: NOW }), []);
});

// ─── the dispatcher board as a second opinion on where the driver is ─────────

const ON_ROAD = { state: 'road', stateSince: '2026-09-01T00:00:00Z' };
const AT_HOME = { state: 'home', stateSince: '2026-09-10T00:00:00Z' };

test('board says home, Home Time says road — a contradiction naming both sides', () => {
  const found = findContradictions(describeContext({
    homeTime: ON_ROAD,
    board: { says: 'home', status: 'HOME', statusRaw: 'HOME', truck: '322', lastSeenAt: '2026-09-12T10:00:00Z' },
  }));
  assert.deepEqual(found.map((c) => c.kind), ['board_home_while_road']);
  assert.deepEqual(found[0].sides, ['board', 'home_time']);
  assert.equal(found[0].evidence.truck, '322');
  assert.match(found[0].summary, /dispatcher board/i);
  assert.match(found[0].summary, /Home Time/);
});

test('Home Time says home, board says working — the mirror case', () => {
  const found = findContradictions(describeContext({
    homeTime: AT_HOME,
    board: { says: 'working', status: 'ENROUTE', statusRaw: 'ENROUTE', truck: '322' },
  }));
  assert.deepEqual(found.map((c) => c.kind), ['wenze_home_while_board_working']);
  assert.deepEqual(found[0].sides, ['home_time', 'board']);
});

test('A NEUTRAL BOARD STATUS CONTRADICTS NOTHING, in either direction', () => {
  // REST and SHOP say nothing about where a driver is, and treating them as
  // "not home therefore working" accuses a resting driver of a contradiction.
  for (const homeTime of [ON_ROAD, AT_HOME]) {
    const found = findContradictions(describeContext({
      homeTime, board: { says: 'neutral', status: 'REST' },
    }));
    assert.deepEqual(found.filter((c) => c.kind.includes('board')), []);
  }
});

test('an unknown board status contradicts nothing', () => {
  const found = findContradictions(describeContext({
    homeTime: ON_ROAD, board: { says: 'unknown', status: 'DETAINED' },
  }));
  assert.deepEqual(found.filter((c) => c.kind.includes('board')), []);
});

test('A BOARD NOBODY COULD READ IS NOT A SIDE', () => {
  // `known: false` is the shape a stale or missing snapshot takes. "Nobody has
  // looked" must never be quoted as evidence against Home Time.
  const found = findContradictions(describeContext({ homeTime: ON_ROAD, board: null }));
  assert.deepEqual(found.filter((c) => c.kind.includes('board')), []);
});

test('a board opinion with no home-time reading contradicts nothing', () => {
  const found = findContradictions(describeContext({
    homeTime: null, board: { says: 'home', status: 'HOME' },
  }));
  assert.deepEqual(found.filter((c) => c.kind.includes('board')), []);
});

test('agreement is silence', () => {
  const agreeing = [
    [ON_ROAD, { says: 'working', status: 'ENROUTE' }],
    [AT_HOME, { says: 'home', status: 'HOME' }],
  ];
  for (const [homeTime, board] of agreeing) {
    assert.deepEqual(findContradictions(describeContext({ homeTime, board })), []);
  }
});

test('the board section is present and marked unknown when nothing was read', () => {
  assert.deepEqual(describeContext({}).board, { known: false });
});
