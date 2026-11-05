'use strict';

/**
 * services/fleetCrossCheck/report.js — the reads behind the comparison:
 * read-only, built at most once per ten minutes (Datatruck's allowance is
 * shared with the Gross Grand Prix), and a Datatruck that cannot be read is
 * said rather than shown as agreement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFleetCrossCheck, TTL_MS } = require('../services/fleetCrossCheck/report');

function deps({ configured = true, failDatatruck = false } = {}) {
  let now = Date.parse('2026-11-05T12:00:00Z');
  const calls = { drivers: 0, orders: 0, sql: [] };
  return {
    calls,
    advance: (ms) => { now += ms; },
    deps: {
      now: () => now,
      boardRows: {
        listBoardRows: async () => [{ truckRaw: '313 COMP', truckNorm: '313', fleetType: 'company', cleanName: 'ONESIAS FLENCH', teamMembers: [], status: 'ENROUTE' }],
      },
      db: {
        query: async (sql) => {
          calls.sql.push(sql);
          return { rows: [{ unit_number: '313', fleet_type: 'company', display_name: 'ONESIAS FLENCH', group_name: 'WENZE UNIT # 313 ONESIAS FLENCH' }] };
        },
      },
      datatruck: {
        isConfigured: () => configured,
        fetchAllDrivers: async () => { calls.drivers += 1; if (failDatatruck) { const e = new Error('nope https://x.datatruck.io/?token=abc'); e.status = 429; throw e; } return [{ account: { full_name: 'Onesias Flench' }, driver_type: 'company_driver' }]; },
        fetchOrdersByPickupWindow: async () => { calls.orders += 1; return [{ trip: { truck__unit_number: '313 COMP', driver__full_name: 'Onesias Flench' }, pickup_time: '2026-11-04T10:00:00Z' }]; },
      },
    },
  };
}

test('the three sources are read and compared; only SELECTs reach the database', async () => {
  const d = deps();
  const report = await createFleetCrossCheck(d.deps).getReport();
  assert.equal(report.summary.boardRows, 1);
  assert.equal(report.summary.allAgree, 1);
  assert.equal(report.datatruck.read, true);
  assert.equal(report.fromCache, false);
  assert.ok(d.calls.sql.every((s) => /^\s*SELECT/i.test(s)), 'read-only');
});

test('built at most once per ten minutes, even when asked to refresh', async () => {
  const d = deps();
  const cc = createFleetCrossCheck(d.deps);
  await cc.getReport();
  const again = await cc.getReport({ refresh: true });
  assert.equal(again.fromCache, true);
  assert.match(again.refreshRefused, /10 minutes/);
  assert.equal(d.calls.orders, 1, 'Datatruck was asked once');
  d.advance(TTL_MS + 1);
  const later = await cc.getReport({ refresh: true });
  assert.equal(later.fromCache, false);
  assert.equal(d.calls.orders, 2);
});

test('two presses at once start one build', async () => {
  const d = deps();
  const cc = createFleetCrossCheck(d.deps);
  await Promise.all([cc.getReport(), cc.getReport()]);
  assert.equal(d.calls.drivers, 1);
});

test('Datatruck not connected: said plainly, and the Wenze half still stands', async () => {
  const d = deps({ configured: false });
  const report = await createFleetCrossCheck(d.deps).getReport();
  assert.equal(report.datatruck.read, false);
  assert.match(report.datatruck.reason, /not connected/);
  assert.equal(report.rows[0].datatruck.read, false);
  assert.equal(report.summary.allAgree, 1);
  assert.equal(d.calls.drivers, 0);
});

test('Datatruck refusing: the status code, never the URL or the token', async () => {
  const d = deps({ failDatatruck: true });
  const report = await createFleetCrossCheck(d.deps).getReport();
  assert.equal(report.datatruck.read, false);
  assert.equal(report.datatruck.reason, 'Datatruck could not be read (HTTP 429).');
  assert.doesNotMatch(JSON.stringify(report), /token=|datatruck\.io/);
});
