'use strict';

/**
 * What ONE load-control pass costs the database.
 *
 * October 2026: the hosted database's monthly transfer allowance was nearly
 * spent, and load control was its largest consumer, about 110 MB a day. Every
 * ten minutes, for each of ~205 loads, it read `SELECT *` from two tables and
 * echoed its write back with `RETURNING *`. The ~112 open findings it re-files
 * every pass came back whole too, evidence included.
 *
 * The real data layer runs here over a fake `pg` that records every statement;
 * only the load board, the fleet and the chat are stand-ins. The pass now asks
 * each table ONCE, however many loads there are, and reads back nothing it
 * writes.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const sent = [];
const textOf = (q) => (typeof q === 'string' ? q : q?.text || '');

function respond(text) {
  if (/FROM groups/.test(text)) {
    return { rows: [{ id: 7, group_name: 'WENZE UNIT # 310 A DRIVER' }], rowCount: 1 };
  }
  if (/FROM driver_units/.test(text)) return { rows: [{ unit_number: '310', person_id: 11 }], rowCount: 1 };
  if (/INSERT INTO operational_findings/.test(text)) return { rows: [{ id: 1 }], rowCount: 1 };
  if (/^\s*(INSERT|UPDATE|DELETE)/.test(text)) return { rows: [], rowCount: 1 };
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
const watcher = require('../services/loads/lifecycleWatch');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const SHIPPER = { lat: 41.88, lng: -87.63 };
const RECEIVER = { lat: 39.10, lng: -84.50 };

/** Half the board is ordinary; the other half says delivered while the truck sits at the shipper. */
function boardOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    orderId: `ORD-${i}`, loadIdentifier: `L${i}`, unitNumber: '310',
    status: i % 2 ? 'delivered' : 'dispatched',
    pickupLat: SHIPPER.lat, pickupLng: SHIPPER.lng,
    deliveryLat: RECEIVER.lat, deliveryLng: RECEIVER.lng,
  }));
}

function depsFor(orders) {
  return {
    store: require('../database/loadLifecycle'),
    groups: require('../database/groups'),
    people: require('../database/driverPeople'),
    findings: require('../database/operationalFindings'),
    notifications: require('../database/operationalNotifications'),
    eldSettings: { async getEldConfig() { return {}; } },
    providers: {
      async fetchProviderFleets() { return { fleets: {}, errors: [] }; },
      resolveLocationForUnit() {
        return { location: { ...SHIPPER, speedMph: 0, lastUpdated: new Date(NOW - 300000).toISOString() } };
      },
    },
    orders: { async getActiveOrders() { return { orders, error: null }; } },
    loads: { extractLoadFromOrder: (o) => o },
    notify: async () => ({ recorded: true }),
    reviewAlarm: async () => null,
  };
}
/* eslint-enable global-require */

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const WHOLE_ROW = /RETURNING \*|SELECT \*|SELECT [a-z_]+\.\*/i;
/** A read, other than the per-notice "was this said today?" look, which is one short row. */
const isTableRead = (s) => /^SELECT/i.test(s) && !/FROM operational_notifications/.test(s);

async function onePass(n) {
  sent.length = 0;
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps: depsFor(boardOf(n)) });
  const statements = sent.map(oneLine);
  const listing = statements.map((s) => `  ${s.slice(0, 110)}`).join('\n');
  return { summary, statements, listing };
}

test('A LOAD PASS reads each table ONCE, and reads back nothing it writes', async () => {
  const { summary, statements, listing } = await onePass(40);
  assert.equal(summary.checked, 40);
  assert.equal(summary.asked, 20, 'the delivered-but-at-the-shipper half is filed');

  assert.deepEqual(statements.filter((s) => WHOLE_ROW.test(s)).map((s) => s.slice(0, 110)), [],
    `whole rows read or echoed back:\n${listing}`);
  // The driver groups, the unit holders, and where every load stood before.
  assert.equal(statements.filter(isTableRead).length, 3, `table reads in one pass:\n${listing}`);
});

test('the reads do not grow with the board — forty loads cost what two do', async () => {
  const two = await onePass(2);
  const forty = await onePass(40);
  assert.equal(forty.statements.filter(isTableRead).length, two.statements.filter(isTableRead).length,
    forty.listing);
});

test('a filed finding comes back as its id alone — the evidence is not echoed', async () => {
  const { statements } = await onePass(2);
  const filing = statements.find((s) => /^INSERT INTO operational_findings/.test(s));
  assert.match(filing, /RETURNING id$/);
});
