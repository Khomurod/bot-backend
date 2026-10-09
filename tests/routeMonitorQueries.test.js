'use strict';

/**
 * What ONE Route Control monitor tick costs the database.
 *
 * October 2026: the hosted database's monthly transfer allowance was nearly
 * spent, and an audit put the monitor at about 1 MB a day with no route at all
 * plus about 4 MB a day for every tracked route. Every tick read the GMaps
 * settings whole (a 30-second cache cannot survive a 300-second tick), read
 * every active route whole — 62 columns, polyline, link, waypoints and message
 * list included — and echoed each route's monitoring write straight back with
 * `RETURNING *`, along with every event it logged.
 *
 * The REAL monitor and data layer run here over helpers/routeMonitorFakePg.js,
 * which projects every column list from full rows and prices each response by
 * the wire format; only live GPS and Telegram are stand-ins.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/routeMonitorFakePg'); // installs `pg` and the GPS stand-in

/* eslint-disable global-require */
const monitor = require('../services/routeControl/monitor');
const gmaps = require('../database/gmapsSettings');
/* eslint-enable global-require */

const { world } = fake;
const WHOLE_ROW = /RETURNING \*|SELECT \*|SELECT [a-z_]+\.\*/i;
const ROUTE = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
const END = { lat: 43.252, lng: -126.453 };
const POLYLINE_A = fake.densePolyline(ROUTE);
// A second geometry that runs straight through OFF_ROUTE below.
const POLYLINE_B = fake.densePolyline([[38.5, -119.0], [40.0, -119.0]]);

const gps = (latitude, longitude, speed = 60) => ({
  latitude, longitude, speedMilesPerHour: speed, pingAgeMinutes: 1,
});
const OFF_ROUTE = gps(38.5, -119.0);
const ON_ROUTE = gps(38.5, -120.2);
const AT_END = gps(END.lat, END.lng, 0);
const FAR_AWAY = gps(30.0, -90.0);

const listing = (statements) => statements.map((s) => `  [${s.bytes} B] ${s.sql.slice(0, 120)}`).join('\n');
const carriesPolyline = (s) => s.fields.includes('encoded_polyline');
const bytesOf = (statements) => statements.reduce((n, s) => n + s.bytes, 0);

/** A fresh world with the settings cache cleared, so each test reads its own switch. */
function scene({ gmapsEnabled = true } = {}) {
  fake.reset({ gmapsEnabled });
  gmaps.invalidateCache();
}

function addRoute(id, unit, overrides = {}) {
  fake.addGroup(id, `WENZE UNIT ${unit || id} TEST DRIVER`);
  const row = fake.routeRow({
    id, group_id: id, unit_number: unit, encoded_polyline: POLYLINE_A,
    destination_lat: END.lat, destination_lng: END.lng, ...overrides,
  });
  world.routes.push(row);
  return row;
}

test.before(async () => {
  // The tick needs the service's Telegram client; start it and stop the timers at once.
  await monitor.startRouteControlService(fake.telegram);
  monitor.stopRouteControlService();
});

test('A BUSY TICK reads no whole row and echoes nothing back — in every branch', async () => {
  scene();
  addRoute(101, '101', { consecutive_off_route: 2 });                     // off route → warned
  addRoute(102, '102', { tracking_status: 'pending', tracking_start_mode: 'after_message_sent' }); // starts
  addRoute(103, '103', {                                                   // waits, reason changes
    tracking_status: 'pending', tracking_start_mode: 'scheduled_time',
    tracking_start_at: new Date('2027-01-01T00:00:00Z'), driver_group_message_sent_at: null,
  });
  addRoute(104, '104', { destination_lat: null, destination_lng: null }); // repaired from the polyline, completes
  addRoute(105, null);                                                     // unit from the driver profile
  fake.addProfile(105, '777');
  world.locations.set('101', OFF_ROUTE).set('102', FAR_AWAY).set('103', FAR_AWAY)
    .set('104', AT_END).set('777', ON_ROUTE);

  const statements = await fake.record(() => monitor.tick());

  assert.deepEqual(statements.filter((s) => WHOLE_ROW.test(s.sql)).map((s) => s.sql.slice(0, 110)), [],
    `whole rows read or echoed back on the tick path:\n${listing(statements)}`);

  // …and it still did everything it always did.
  assert.deepEqual(world.events.map((e) => [e.assignment_id, e.event_type]), [
    [101, 'notification'],
    [102, 'tracking_started'],
    [103, 'tracking_start_waiting_for_time'],
    [104, 'destination_repaired'],
    [104, 'destination_reached'],
    [105, 'check'],
  ]);
  assert.equal(world.sends.length, 1, 'exactly one off-route warning');
  assert.equal(world.sends[0].chatId, world.groups.get(101).telegram_group_id);
  assert.match(world.sends[0].text, /off the assigned route/);
  assert.equal(world.routes.find((r) => r.id === 102).tracking_status, 'active');
  assert.equal(world.routes.find((r) => r.id === 104).status, 'completed');
  assert.equal(world.resolved.find((r) => r.groupTitle.includes('UNIT 105')).unitNumber, '777',
    'a route with no stored unit still resolves GPS by the profile unit');
  assert.deepEqual(world.monitorStates.map((m) => [m.id, m.result]), [[101, 'off_route'], [105, 'on_route']]);
});

test('THE POLYLINE is not read when nothing needs it', async () => {
  // Google Maps off: no off-route evaluation, and both routes have destination
  // coordinates, so the repair that reads the polyline end never runs.
  scene({ gmapsEnabled: false });
  addRoute(201, '201');
  addRoute(202, '202', {
    tracking_status: 'pending', tracking_start_mode: 'after_message_sent',
    driver_group_message_sent_at: null, tracking_hold_reason: 'waiting_for_message',
  });
  world.locations.set('201', OFF_ROUTE).set('202', FAR_AWAY);

  let statements = await fake.record(() => monitor.tick());
  assert.deepEqual(statements.filter(carriesPolyline).map((s) => s.sql.slice(0, 110)), [],
    `the polyline was read with Google Maps off:\n${listing(statements)}`);
  assert.deepEqual(world.diagnostics.map((d) => [d.id, d.blockedReason]),
    [[201, 'OUTSIDE_COMPLETION_RADIUS'], [202, 'OUTSIDE_COMPLETION_RADIUS']], 'completion still ran');
  assert.equal(world.sends.length, 0);
  assert.equal(world.monitorStates.length, 0, 'no off-route evaluation while Google Maps is off');

  // Google Maps on, but the only route is still waiting to start: pending
  // routes are never evaluated against the route, so still no polyline.
  world.gmaps.enabled = true;
  gmaps.invalidateCache();
  world.routes = world.routes.filter((r) => r.id === 202);
  statements = await fake.record(() => monitor.tick());
  assert.deepEqual(statements.filter(carriesPolyline).map((s) => s.sql.slice(0, 110)), [],
    `the polyline was read for a pending route:\n${listing(statements)}`);
});

test('THE POLYLINE is read once, remembered, and read again only when it changes', async (t) => {
  scene();
  const row = addRoute(301, '301');
  world.locations.set('301', OFF_ROUTE);

  const first = await fake.record(() => monitor.tick());
  assert.equal(first.filter(carriesPolyline).length, 1, `first tick:\n${listing(first)}`);
  assert.equal(world.monitorStates.at(-1).result, 'off_route');

  const second = await fake.record(() => monitor.tick());
  assert.equal(second.filter(carriesPolyline).length, 0, `second tick re-read it:\n${listing(second)}`);
  assert.equal(world.monitorStates.at(-1).result, 'off_route', 'the remembered polyline is used');

  // The route is recomputed: the new geometry runs through the driver.
  row.encoded_polyline = POLYLINE_B;
  const third = await fake.record(() => monitor.tick());
  assert.equal(third.filter(carriesPolyline).length, 1, `a changed polyline must be re-read:\n${listing(third)}`);
  assert.equal(world.monitorStates.at(-1).result, 'on_route', 'and the NEW one is what the driver is checked against');

  const fourth = await fake.record(() => monitor.tick());
  assert.equal(fourth.filter(carriesPolyline).length, 0, listing(fourth));

  // One tracked route, steady state: the run ledger, one probe, one narrow
  // read, and three writes that read nothing back.
  t.diagnostic(`steady-state tick, one tracked route: ${fourth.length} statements, ~${bytesOf(fourth)} B`);
  assert.ok(bytesOf(fourth) <= 1600, `a tracked route's tick costs ${bytesOf(fourth)} B:\n${listing(fourth)}`);
});

test('AN IDLE TICK asks one narrow question and nothing more', async (t) => {
  scene();
  await fake.atMinute(0, () => monitor.tick()); // the settings are read once…
  const statements = await fake.atMinute(5, () => fake.record(() => monitor.tick()));

  const reads = statements.filter((s) => s.fields.length);
  t.diagnostic(`idle tick: ${statements.length} statements, ~${bytesOf(statements)} B`);
  // …and not again five minutes later. What is left is "is any route active?".
  assert.deepEqual(reads.map((s) => s.fields), [['id']], `an idle tick read:\n${listing(statements)}`);
  assert.ok(bytesOf(statements) <= 64, `an idle tick costs ${bytesOf(statements)} B:\n${listing(statements)}`);
});
