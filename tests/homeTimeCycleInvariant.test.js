/**
 * The invariant nothing asserted, which is why it broke.
 *
 *   A CHANGE OF STATE MUST OPEN OR CLOSE A CYCLE.
 *
 * `driver_road_history.return_to_road_at` had exactly one writer, reachable only
 * from a driver-group message. Two of the four paths that move
 * `driver_home_status` never touched a cycle at all — the admin state flip and
 * the screenshot import — so the flip-flop moved and the cycle stayed open
 * forever. Production carries 74 open cycles out of 79.
 *
 * Every test in this area verified that the CORRECT path did the right thing.
 * `tests/homeTimeStatusRoute.test.js` is the test that would have caught the
 * admin leak and by construction could not: its mock has no road-history surface
 * at all, so the missing close was invisible to it. `applyRows` — the import
 * writer — had no test whatsoever.
 *
 * So this file tests the paths that were wrong, and asserts the negative: after
 * a `home → road` change, by ANY route, no open cycle may remain.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HT = path.resolve(__dirname, '../database/homeTime.js');
const GROUPS = path.resolve(__dirname, '../database/groups.js');
const ROAD_BONUS = path.resolve(__dirname, '../services/roadBonusPoster.js');
const DB = path.resolve(__dirname, '../database/db.js');

/**
 * An in-memory home-time world: one group, one status row, a cycle table.
 *
 * Modelled on the real semantics rather than the real SQL — `closeHomeStay` only
 * closes a still-open row, and `getOpenHomeStay` returns the NEWEST open one,
 * which is the LIMIT 1 that makes an older open cycle unreachable.
 */
function world({ state = 'home', stateSince = '2026-08-25T00:00:00.000Z', settings = {} } = {}) {
  const cycles = [];
  let status = state
    ? { group_id: 1, state, state_since: stateSince, road_bonus_weeks_notified: 3 }
    : null;
  const posted = [];

  const ht = {
    async getHomeTimeSettings() {
      return { enabled: true, road_allowance_weeks: 4, bonus_per_week: 100, ...settings };
    },
    async getDriverHomeStatus() { return status; },
    async upsertDriverHomeStatus(patch) {
      status = {
        group_id: 1,
        state: patch.state,
        state_since: patch.stateSince,
        road_bonus_weeks_notified: patch.roadBonusWeeksNotified ?? 0,
      };
    },
    async touchDriverHomeStatus() {},
    async setDriverHomeState(groupId, { state: s, stateSince: since }) {
      if (!status) return null;
      status = { ...status, state: s || status.state, state_since: since || status.state_since };
      return status;
    },
    async insertRoadHistory(row) {
      const created = {
        id: cycles.length + 1,
        group_id: row.groupId,
        road_started_at: row.roadStartedAt,
        home_arrived_at: row.homeArrivedAt,
        bonus_usd: row.bonusUsd,
        return_to_road_at: null,
        home_days: null,
        linked_request_id: null,
        // Born claimed on a silent path — one statement, no window.
        bonus_posted_at: row.bonusPostedAt ?? null,
      };
      cycles.push(created);
      return created;
    },
    async getOpenHomeStay() {
      // Newest open row only — the real LIMIT 1.
      const open = cycles.filter((c) => c.return_to_road_at == null);
      return open.length ? open[open.length - 1] : null;
    },
    async listOpenHomeStays() {
      // Every open row of this driver, newest first — the person-aware read.
      return cycles.filter((c) => c.return_to_road_at == null).slice().reverse();
    },
    async closeHomeStay(id, { returnToRoadAt, homeDays, linkedRequestId }) {
      const row = cycles.find((c) => c.id === id && c.return_to_road_at == null);
      if (!row) return null;
      row.return_to_road_at = returnToRoadAt;
      row.home_days = homeDays ?? null;
      row.linked_request_id = linkedRequestId ?? row.linked_request_id;
      return row;
    },
    async claimRoadBonusPost(id) {
      const row = cycles.find((c) => c.id === id && c.bonus_posted_at == null);
      if (!row) return null;
      row.bonus_posted_at = new Date().toISOString();
      return row;
    },
    async findDecidedRequestNearDate() { return null; },
    async expireOpenClarificationsForGroup() {},
  };

  require.cache[HT] = { exports: ht };
  // `resolveDriverLabel` reads the profile through database/db, not homeTime —
  // and it SWALLOWS a failure, falling back to inferring the type from the group
  // title. Without this mock the driver reads as an owner-operator, `overLimit`
  // is false, and the bonus assertions below silently test nothing.
  require.cache[DB] = {
    exports: {
      async getDriverProfileByGroupId() {
        return { first_name: 'A', last_name: 'ONE', unit_number: '27', driver_type: 'company_driver' };
      },
    },
  };
  require.cache[GROUPS] = {
    exports: {
      async getGroupByIdAnyType() {
        return { id: 1, telegram_group_id: -100, group_name: 'WENZE UNIT # 27 A', group_type: 'driver' };
      },
    },
  };
  require.cache[ROAD_BONUS] = {
    exports: {
      async postCompletedRoadLeg(_t, row) { posted.push(row.id); },
    },
  };

  for (const p of [
    '../services/homeTimeService',
    '../services/homeTimeImportService',
  ]) delete require.cache[require.resolve(p)];

  return { cycles, posted, ht, status: () => status };
}

const openCycles = (cycles) => cycles.filter((c) => c.return_to_road_at == null);
const GROUP = { id: 1, telegram_group_id: -100, group_name: 'WENZE UNIT # 27 A', group_type: 'driver' };

// ─── the invariant, on the path that was already correct ─────────────────────

test('a driver-group home→road message closes the cycle', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  const { applyStateTransition } = require('../services/homeTimeService');

  // road → home opens a cycle...
  await applyStateTransition(null, GROUP, { newState: 'home', eventAt: '2026-08-25T00:00:00.000Z' });
  assert.equal(w.cycles.length, 1);
  assert.equal(openCycles(w.cycles).length, 1);

  // ...and home → road must close it.
  await applyStateTransition(null, GROUP, { newState: 'road', eventAt: '2026-08-31T00:00:00.000Z' });
  assert.deepEqual(openCycles(w.cycles), [], 'no open cycle may survive a home→road change');
  assert.equal(w.cycles[0].home_days, 6);
});

// ─── the two paths that were wrong ───────────────────────────────────────────

test('an ADMIN flipping home→road closes the cycle', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  const { applyStateTransition } = require('../services/homeTimeService');
  await applyStateTransition(null, GROUP, { newState: 'home', eventAt: '2026-08-25T00:00:00.000Z' });
  assert.equal(openCycles(w.cycles).length, 1);

  // The admin route's effective call, after the fix.
  await applyStateTransition(null, GROUP, {
    newState: 'road', eventAt: '2026-08-31T00:00:00.000Z',
    statusText: 'Corrected by an administrator', announce: false,
  });

  assert.deepEqual(openCycles(w.cycles), [],
    'an admin correcting a driver used to leave the cycle open forever');
});

test('an ADMIN flipping road→home opens a cycle, silently', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  const { applyStateTransition } = require('../services/homeTimeService');

  await applyStateTransition(null, GROUP, {
    newState: 'home', eventAt: '2026-08-25T00:00:00.000Z', announce: false,
  });

  assert.equal(w.cycles.length, 1, 'the road leg is recorded, not lost');
  assert.deepEqual(w.posted, [], 'but nobody is congratulated for a correction');
  assert.ok(w.cycles[0].bonus_posted_at,
    'and the notifier is told it is handled, or it posts the bonus an hour later anyway');
});

test('a SCREENSHOT IMPORT keeps cycles consistent and announces nothing', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  const { applyRows } = require('../services/homeTimeImportService');

  // Import says: this driver is home since 25 Aug.
  await applyRows([{ group_id: 1, telegram_group_id: -100, status: 'home', since_date: '2026-08-25' }]);
  assert.equal(w.cycles.length, 1, 'the import opens the cycle it implies');
  assert.deepEqual(w.posted, [], 'importing last quarter must not fire stale bonus posts');

  // A later import says: back on the road.
  await applyRows([{ group_id: 1, telegram_group_id: -100, status: 'road', since_date: '2026-08-31' }]);
  assert.deepEqual(openCycles(w.cycles), [],
    'the import used to move the flip-flop and leave the cycle open');
});

test('the import no longer resets the extra-week watermark', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  const { applyRows } = require('../services/homeTimeImportService');

  // Same state as already recorded — nothing should change.
  await applyRows([{ group_id: 1, telegram_group_id: -100, status: 'road', since_date: '2026-07-08' }]);

  assert.equal(w.status().road_bonus_weeks_notified, 3,
    'the old direct write defaulted this to 0 on every import, re-arming posted milestones');
});

// ─── the structural blind spot the repair exists for ─────────────────────────

test('a lingering open cycle is closed by the NEXT leg, with the observed road start — nothing stays hidden', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  const { applyStateTransition } = require('../services/homeTimeService');

  // The damage as production had it: two cycles opened without a close between
  // them, as the old import could do. `getOpenHomeStay` is LIMIT 1, so the older
  // one used to be structurally unreachable by normal operation.
  await w.ht.insertRoadHistory({
    groupId: 1, roadStartedAt: '2026-06-01T00:00:00.000Z', homeArrivedAt: '2026-07-01T00:00:00.000Z',
  });
  await w.ht.insertRoadHistory({
    groupId: 1, roadStartedAt: '2026-07-08T00:00:00.000Z', homeArrivedAt: '2026-08-25T00:00:00.000Z',
  });
  assert.equal(openCycles(w.cycles).length, 2);

  await applyStateTransition(null, GROUP, { newState: 'home', eventAt: '2026-08-26T00:00:00.000Z' });
  // The road→home insert closed EVERYTHING still open for this driver first,
  // with the road start it was about to record (2026-07-08) as their return —
  // a road→home can only follow a road state, so that moment IS the observed
  // return (class-B evidence, seen from this side). Only the new stay is open.
  assert.equal(openCycles(w.cycles).length, 1, 'one open stay per group — the index can hold');
  assert.equal(w.cycles[0].return_to_road_at, '2026-07-08T00:00:00.000Z');
  assert.equal(w.cycles[1].return_to_road_at, '2026-07-08T00:00:00.000Z');

  await applyStateTransition(null, GROUP, { newState: 'road', eventAt: '2026-08-31T00:00:00.000Z' });
  assert.equal(openCycles(w.cycles).length, 0, 'and the new stay closes on the return');
});

// ─── with the feature off, nothing pretends otherwise ────────────────────────

test('with home-time tracking off, no cycle is invented', async () => {
  const w = world({ state: 'road', settings: { enabled: false } });
  const { applyStateTransition } = require('../services/homeTimeService');

  const result = await applyStateTransition(null, GROUP, {
    newState: 'home', eventAt: '2026-08-25T00:00:00.000Z',
  });

  assert.equal(result.disabled, true, 'reported as disabled, not as a failure');
  assert.deepEqual(w.cycles, []);
});

test('an import still records state when tracking is off', async () => {
  const w = world({ state: 'road', settings: { enabled: false } });
  const { applyRows } = require('../services/homeTimeImportService');

  const report = await applyRows([
    { group_id: 1, telegram_group_id: -100, status: 'home', since_date: '2026-08-25' },
  ]);

  assert.equal(report.statusesUpdated, 1, 'the import must not be a silent no-op');
  assert.equal(w.status().state, 'home');
  assert.deepEqual(w.cycles, [], 'and with tracking off there is no cycle to keep consistent');
});


// ─── review findings on #171 ─────────────────────────────────────────────────

test('a corrected import date moves the clock even when the state is unchanged', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  const { applyRows } = require('../services/homeTimeImportService');

  // "Still on the road — but they actually left on the 3rd."
  const report = await applyRows([
    { group_id: 1, telegram_group_id: -100, status: 'road', since_date: '2026-07-03' },
  ]);

  assert.equal(w.status().state_since, '2026-07-03T00:00:00.000Z',
    'the same-state branch used to touch only the last-status fields, so the road '
    + 'clock kept its wrong start while the import reported the row as updated');
  assert.equal(report.statusesUpdated, 1);
});

test('a repeated driver message does NOT reset the clock', async () => {
  const w = world({ state: 'home', stateSince: '2026-08-25T00:00:00.000Z' });
  const { applyStateTransition } = require('../services/homeTimeService');

  // The driver-message path must never resync — otherwise every repeated
  // "Status: Home" restarts the stay.
  await applyStateTransition(null, GROUP, {
    newState: 'home', eventAt: '2026-09-01T00:00:00.000Z', statusText: 'Status: Home',
  });

  assert.equal(w.status().state_since, '2026-08-25T00:00:00.000Z',
    'resyncSince is opt-in for exactly this reason');
});

test('"tracking is off" and "it failed" are different answers', async () => {
  const off = world({ state: 'road', settings: { enabled: false } });
  const { applyStateTransition } = require('../services/homeTimeService');

  const disabled = await applyStateTransition(null, GROUP, {
    newState: 'home', eventAt: '2026-08-25T00:00:00.000Z',
  });
  assert.equal(disabled.disabled, true, 'disabled is reported, not returned as null');
  assert.equal(disabled.transition, null, 'and carries no transition, so old callers are unaffected');
  assert.deepEqual(off.cycles, []);

  // A hard failure still answers null — the two must not be confused, because a
  // caller that falls back to a direct state write on "disabled" would then move
  // the flip-flop without its cycle on a transient error.
  const broken = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  broken.ht.insertRoadHistory = async () => { throw new Error('database went away'); };
  // `world()` purges the module cache, so this needs its own require — the
  // reference above still closes over the first world's stubs.
  const { applyStateTransition: applyOnBroken } = require('../services/homeTimeService');
  const failed = await applyOnBroken(null, GROUP, {
    newState: 'home', eventAt: '2026-08-25T00:00:00.000Z',
  });
  assert.equal(failed, null, 'a real failure stays null, and must never be mistaken for disabled');
});

test('an import whose transition fails does not write the state anyway', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  w.ht.insertRoadHistory = async () => { throw new Error('database went away'); };
  const { applyRows } = require('../services/homeTimeImportService');

  const report = await applyRows([
    { group_id: 1, telegram_group_id: -100, status: 'home', since_date: '2026-08-25' },
  ]);

  assert.equal(report.statusFailed, 1);
  assert.equal(report.statusesUpdated, 0);
  assert.equal(w.status().state, 'road',
    'writing the state anyway is exactly how the flip-flop moves without its cycle');
});

test('a silently recorded bonus is claimed by the INSERT, not by a follow-up', async () => {
  const w = world({ state: 'road', stateSince: '2026-07-08T00:00:00.000Z' });
  // If the claim were a separate statement, failing it would leave the row
  // postable and the notifier would fire a stale bonus an hour later. There is
  // no separate statement to fail.
  w.ht.claimRoadBonusPost = async () => { throw new Error('claim must not be needed'); };
  const { applyStateTransition } = require('../services/homeTimeService');

  await applyStateTransition(null, GROUP, {
    newState: 'home', eventAt: '2026-08-25T00:00:00.000Z', announce: false,
  });

  assert.equal(w.cycles.length, 1);
  assert.ok(w.cycles[0].bonus_posted_at, 'born claimed');
  assert.deepEqual(w.posted, []);
});
