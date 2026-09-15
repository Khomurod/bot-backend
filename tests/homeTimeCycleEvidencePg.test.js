'use strict';

/**
 * A home cycle records WHO said it opened and WHO said it closed.
 *
 * The provenance columns are the whole point of Area 4: a manager reading
 * "home 14 - 18 Sep" has to be able to ask whether a person wrote that or the
 * dispatcher board did. Only a real database proves the columns exist, survive
 * a re-run of every migration, and are not overwritten by a later close.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { homeTime: ht } = h.loadDataLayer(['homeTime']);
  const group = (await h.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active)
     VALUES (-100501, 'WENZE UNIT # 310', 'driver', TRUE) RETURNING id`
  )).rows[0].id;
  return { h, ht, group };
}

test('a CLOSED request survives a restart — the widened CHECK is in the baseline', async (t) => {
  if (skipWithoutPg(t)) return;
  // THE BASELINE ALONE, with no migrations, because that is what a boot
  // re-applies. Migration 0029 re-narrows this constraint and 0059 widens it
  // again, but neither ever runs twice: they are run-once and ledgered.
  const h = await createPgHarness(t);
  await h.query(
    `INSERT INTO home_time_requests (telegram_group_id, driver_name, status)
     VALUES (-100501, 'JOHN SMITH', 'closed')`
  );
  // THIS IS A RESTART, and it is the whole reason the widened CHECK also lives
  // in the baseline. `schema.sql` is re-applied VERBATIM on every boot and its
  // DROP / ADD CONSTRAINT pair is unconditional. A status added by migration
  // 0059 alone would survive exactly one restart, and then every later boot
  // would fail its ADD CONSTRAINT with a 'closed' row in the table - which
  // means the application would not start at all.
  await h.applySchemaSql();
  await h.applySchemaSql();
  const still = await h.query("SELECT COUNT(*)::int AS n FROM home_time_requests WHERE status = 'closed'");
  assert.equal(still.rows[0].n, 1);
});

test('the cycle records the source and the sentence for each side', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h, ht, group } = await setup(t);

  const opened = await ht.insertRoadHistory({
    groupId: group, driverName: 'JOHN SMITH', unitNumber: '310',
    roadStartedAt: '2026-08-01T00:00:00Z', homeArrivedAt: '2026-09-10T00:00:00Z',
    daysOnRoad: 40, exceededWeeks: 1, bonusUsd: 100,
    openedBy: 'dispatcher_board', openedEvidence: 'dispatcher board: HOME, held 90 min',
  });
  assert.equal(opened.opened_by, 'dispatcher_board');
  assert.match(opened.opened_evidence, /HOME/);
  assert.equal(opened.closed_by, null, 'nothing has closed it yet');

  const closed = await ht.closeHomeStay(opened.id, {
    returnToRoadAt: '2026-09-14T00:00:00Z', homeDays: 4, linkedRequestId: null,
    closedBy: 'dispatcher_board', closedEvidence: 'dispatcher board: READY, held 60 min',
  });
  assert.equal(closed.closed_by, 'dispatcher_board');
  assert.match(closed.closed_evidence, /READY/);
  assert.equal(closed.opened_by, 'dispatcher_board', 'the opening record is not overwritten');
});

test('a second close changes nothing — one open cycle, closed once', async (t) => {
  if (skipWithoutPg(t)) return;
  const { ht, group } = await setup(t);
  const row = await ht.insertRoadHistory({
    groupId: group, driverName: 'JOHN SMITH', unitNumber: '310',
    roadStartedAt: '2026-08-01T00:00:00Z', homeArrivedAt: '2026-09-10T00:00:00Z',
    daysOnRoad: 40, exceededWeeks: 1, bonusUsd: 100, openedBy: 'driver_message',
  });
  await ht.closeHomeStay(row.id, {
    returnToRoadAt: '2026-09-14T00:00:00Z', homeDays: 4, closedBy: 'dispatcher_board',
  });
  const again = await ht.closeHomeStay(row.id, {
    returnToRoadAt: '2026-09-20T00:00:00Z', homeDays: 10, closedBy: 'admin',
  });
  assert.equal(again, null, 'a closed cycle is not re-closed by a later sighting');
});

test('a cycle written without provenance is honestly blank, never guessed', async (t) => {
  if (skipWithoutPg(t)) return;
  const { ht, group } = await setup(t);
  const row = await ht.insertRoadHistory({
    groupId: group, driverName: 'JOHN SMITH', unitNumber: '310',
    roadStartedAt: '2026-08-01T00:00:00Z', homeArrivedAt: '2026-09-10T00:00:00Z',
    daysOnRoad: 40, exceededWeeks: 1, bonusUsd: 100,
  });
  assert.equal(row.opened_by, null);
  assert.equal(row.opened_evidence, null);
});

test('a request can be closed, and closing it is not evidence about anybody', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h } = await setup(t);
  const { homeTimeExpiry } = h.loadDataLayer(['homeTimeExpiry']);
  const req = (await h.query(
    `INSERT INTO home_time_requests (telegram_group_id, driver_name, status, home_from, home_to)
     VALUES (-100501, 'JOHN SMITH', 'pending', '2026-09-01', '2026-09-05') RETURNING id`
  )).rows[0].id;

  const closed = await homeTimeExpiry.closeOutdatedHomeTimeRequest(req);
  assert.equal(closed.status, 'closed', "not 'expired' — nobody was waiting to answer it");
  assert.equal(closed.next_reminder_at, null);
  // The retention watch must have no way to read this as a grievance.
  const counted = await h.query(
    `SELECT COUNT(*)::int AS n FROM home_time_requests WHERE status = 'expired'`
  );
  assert.equal(counted.rows[0].n, 0);
  assert.equal(await homeTimeExpiry.closeOutdatedHomeTimeRequest(req), null, 'closing twice is a no-op');
});

test('the board snapshot remembers when the STATUS changed, not when an ETA was retyped', async (t) => {
  if (skipWithoutPg(t)) return;
  const { h } = await setup(t);
  const { dispatchBoard } = h.loadDataLayer(['dispatchBoard']);
  const row = {
    rowKey: '310|JOHN SMITH', driverNameRaw: 'JOHN SMITH (COMPANY DRIVER)', cleanName: 'JOHN SMITH',
    fleetType: 'company', truckNorm: '310', truckDigits: '310', status: 'HOME',
  };
  await dispatchBoard.upsertBoardRows([row]);
  const first = (await h.query("SELECT status_changed_at, last_changed_at FROM dispatch_board_rows WHERE row_key = $1", [row.rowKey])).rows[0];
  assert.ok(first.status_changed_at);

  // An ETA edit moves last_changed_at and must NOT restart the home-time
  // confirmation window.
  await dispatchBoard.upsertBoardRows([{ ...row, etaText: 'Tue 14:00' }]);
  const afterEta = (await h.query("SELECT status_changed_at, last_changed_at FROM dispatch_board_rows WHERE row_key = $1", [row.rowKey])).rows[0];
  assert.equal(afterEta.status_changed_at.getTime(), first.status_changed_at.getTime(),
    'an ETA edit must not restart the confirmation window');
  assert.ok(afterEta.last_changed_at.getTime() > first.last_changed_at.getTime(),
    'the ETA edit is still a real change to the row');

  await dispatchBoard.upsertBoardRows([{ ...row, etaText: 'Tue 14:00', status: 'READY' }]);
  const afterStatus = (await h.query("SELECT status_changed_at FROM dispatch_board_rows WHERE row_key = $1", [row.rowKey])).rows[0];
  assert.ok(afterStatus.status_changed_at.getTime() > first.status_changed_at.getTime(),
    'a status change DOES restart it');
});
