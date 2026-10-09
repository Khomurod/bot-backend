'use strict';

/**
 * What ONE return-to-road pass costs the database.
 *
 * October 2026: the hosted database's monthly transfer allowance was nearly
 * spent, and this watch — every twelve minutes, economy mode or not — was
 * about 12 MB a day of it. For EACH driver at home it sent back the whole
 * 24-column watch row four times: the create echoed it, a `SELECT *` read it,
 * and both observation writes echoed it again, each copy carrying the ~1.7 KB
 * `last_signals` JSON that the pass never reads back.
 *
 * The real data layer — the watch and the findings — runs here over a fake
 * `pg` that records every statement; only the telemetry, the load board and
 * the ELD settings are stand-ins (`getEldConfig` keeps its own cache, which is
 * another change's subject).
 * Per driver the pass now makes ONE narrow read of what the watch remembers,
 * one write that echoes back only the four values the score reads, and one
 * write that returns nothing.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const HOME = { lat: 41.88, lng: -87.63 };

const sent = [];
let atHome = [];

/** SQL comments out, whitespace collapsed: what the statement actually says. */
const clean = (q) => q.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
const textOf = (q) => clean(typeof q === 'string' ? q : q?.text || '');

/** A truck parked where its driver went home, as the database remembers it. */
function watchRow() {
  return {
    group_id: 1, person_id: 11, road_history_id: 401, home_since: new Date(NOW - 3 * 86400000),
    anchor_lat: HOME.lat, anchor_lng: HOME.lng, anchor_at: new Date(NOW - 3 * 86400000), anchor_source: 'live_gps',
    last_lat: HOME.lat, last_lng: HOME.lng, last_speed_mph: 0, last_seen_at: new Date(NOW - 17 * 60000),
    last_checked_at: new Date(NOW - 12 * 60000), max_miles_from_anchor: 0.4, moving_sightings: 0,
    load_identifier: null, load_status: null, load_first_seen_at: null, load_pickup_at: null,
    last_confidence: 'low', last_score: -70,
    last_signals: { signals: [], blockers: ['parked_at_home'], facts: { note: 'x'.repeat(1700) } },
    created_at: new Date(NOW - 3 * 86400000), updated_at: new Date(NOW - 12 * 60000),
  };
}

function respond(text) {
  if (/FROM driver_home_status/.test(text)) return { rows: atHome, rowCount: atHome.length };
  if (/home_time_return_watch/.test(text) && !/^DELETE/.test(text)
    && (/^SELECT/.test(text) || /\bRETURNING\b/.test(text))) {
    return { rows: [watchRow()], rowCount: 1 };
  }
  if (/^(INSERT|UPDATE|DELETE)/.test(text)) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

class FakePool {
  on() {}
  async query(q) { sent.push(textOf(q)); return respond(textOf(q)); }
  async connect() {
    return { query: async (q) => { sent.push(textOf(q)); return respond(textOf(q)); }, release() {} };
  }
}
require.cache[require.resolve('pg')] = { exports: { Pool: FakePool } };

/* eslint-disable global-require */
const watcher = require('../services/homeTime/returnToRoadWatch');

const calls = { fleets: 0, orders: 0 };
function deps() {
  return {
    watch: require('../database/homeTime/returnWatch'),
    findings: require('../database/operationalFindings'),
    eldSettings: { async getEldConfig() { return {}; } },
    providers: {
      async fetchProviderFleets() { calls.fleets += 1; return { fleets: {}, errors: [] }; },
      resolveLocationForUnit() {
        return { location: { ...HOME, speedMph: 0, lastUpdated: new Date(NOW - 5 * 60000).toISOString() } };
      },
    },
    orders: {
      async getActiveOrders() { calls.orders += 1; return { orders: [], error: null }; },
      indexOrdersByUnit: () => new Map(),
      indexOrdersByDriver: () => new Map(),
    },
    loadService: { extractLoadFromOrder: (o) => o },
    datatruck: { normalizeUnitForMatch: String, normalizeNameForMatch: (n) => String(n || '').toLowerCase() },
    reasoner: null,
  };
}
/* eslint-enable global-require */

function driversAtHome(n) {
  return Array.from({ length: n }, (_, i) => ({
    group_id: i + 1, telegram_group_id: `-100${i + 1}`, group_name: `WENZE UNIT # ${700 + i} A DRIVER`,
    samsara_vehicle_id: null, home_since: new Date(NOW - 3 * 86400000), unit_number: String(700 + i),
    first_name: 'A', last_name: 'DRIVER', person_id: 11 + i, road_history_id: 401 + i,
  }));
}

const WHOLE_ROW = /RETURNING \*|SELECT \*|SELECT [a-z_]+\.\*|RETURNING [a-z_]+\.\*/i;
const onWatch = (s) => /home_time_return_watch/.test(s);
const returning = (s) => (s.match(/\bRETURNING (.+)$/) || [])[1] || null;
/** A statement that hands back what the watch REMEMBERS — the read the score is built on. */
const readsWatch = (s) => onWatch(s) && (/^SELECT/.test(s) || /\*|last_seen_at/.test(returning(s) || ''));
const listOf = (clause) => clause.split(',').map((c) => c.trim());

async function onePass(n) {
  atHome = driversAtHome(n);
  sent.length = 0;
  calls.fleets = 0;
  calls.orders = 0;
  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps: deps() });
  const listing = sent.map((s) => `  ${s.slice(0, 120)}`).join('\n');
  return { summary, statements: [...sent], listing };
}

test('A RETURN-TO-ROAD PASS reads no whole rows and echoes none back', async () => {
  const { summary, statements, listing } = await onePass(8);
  assert.equal(summary.checked, 8);
  assert.equal(summary.low, 8, 'eight trucks parked at home: nothing to file');
  assert.equal(summary.driverErrors, 0);
  assert.deepEqual(statements.filter((s) => WHOLE_ROW.test(s)).map((s) => s.slice(0, 120)), [],
    `whole rows read or echoed back:\n${listing}`);
});

test('each driver at home is READ ONCE — not four whole rows', async () => {
  const { statements, listing } = await onePass(8);
  assert.equal(statements.filter(readsWatch).length, 8, `reads of the watch for 8 drivers:\n${listing}`);
});

test('the one read names exactly what the score reads from the watch', async () => {
  const { statements, listing } = await onePass(1);
  const [read] = statements.filter(readsWatch);
  assert.ok(read, listing);
  assert.deepEqual(listOf(returning(read) || read.replace(/^SELECT (.+?) FROM .*$/, '$1')).sort(), [
    'anchor_lat', 'anchor_lng', 'last_lat', 'last_lng', 'last_seen_at', 'last_speed_mph',
    'max_miles_from_anchor', 'moving_sightings',
  ]);
});

test('the sighting write echoes only the four values the score then reads; the verdict write, nothing', async () => {
  const { statements, listing } = await onePass(3);
  const writes = statements.filter((s) => /^UPDATE home_time_return_watch/.test(s));
  assert.equal(writes.length, 6, `two writes per driver:\n${listing}`);
  const echoed = writes.filter((s) => returning(s));
  assert.equal(echoed.length, 3, `one write per driver hands anything back:\n${listing}`);
  for (const s of echoed) {
    assert.deepEqual(listOf(returning(s)), ['anchor_lat', 'anchor_lng', 'max_miles_from_anchor', 'moving_sightings']);
  }
});

test('the per-driver cost is flat: three statements on the watch for each driver', async () => {
  const perDriver = (r) => r.statements.filter((s) => onWatch(s) && !/^DELETE/.test(s)).length;
  const two = await onePass(2);
  const eight = await onePass(8);
  assert.equal((perDriver(eight) - perDriver(two)) / 6, 3, eight.listing);
});

test('the at-home list reads only what the pass uses', async () => {
  const { statements } = await onePass(1);
  const list = statements.find((s) => /FROM driver_home_status/.test(s));
  assert.ok(list);
  assert.doesNotMatch(list, /telegram_group_id|samsara_vehicle_id/,
    'neither is read by anything the pass does with a driver');
});

test('NOBODY HOME costs two cheap statements, and no provider call', async () => {
  const { summary, statements, listing } = await onePass(0);
  assert.equal(summary.skipped, 'nobody_home');
  assert.equal(statements.length, 2, listing);
  assert.match(statements[0], /FROM driver_home_status/);
  assert.match(statements[1], /^DELETE FROM home_time_return_watch/);
  assert.equal(returning(statements[1]), null, 'the tidy-up counts what it dropped; it reads nothing back');
  assert.equal(calls.fleets + calls.orders, 0);
});
