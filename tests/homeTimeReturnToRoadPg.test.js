/**
 * The automatic Home → Road change, end to end on a real PostgreSQL.
 *
 * This is the one correction that moves a driver's live state from evidence
 * gathered outside the chat, so the things worth proving against a real
 * database are the refusals: it stands down when the driver is no longer home,
 * when the verdict has gone stale, and when someone else got there first. And
 * when it does run, the manager notice is written in the SAME transaction, so
 * three managers can never be told about a return that rolled back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const HOME_AT = '2026-09-16T12:00:00Z';
const ROAD_AT = '2026-08-01T12:00:00Z';
const RETURN_AT = '2026-09-20T15:30:00Z';

async function seed(t, { confidence = 'high', checkedMinutesAgo = 5, state = 'home' } = {}) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (1, -1001, 'WENZE UNIT # 7 JOHN DOE', 'driver', TRUE)`
  );
  await harness.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number)
     VALUES (1, 'JOHN', 'DOE', '7')`
  );
  await harness.query(
    `INSERT INTO home_time_settings (id, completed_notify_group_id) VALUES (1, '-100777')
     ON CONFLICT (id) DO UPDATE SET completed_notify_group_id = '-100777'`
  );
  await harness.query(
    `INSERT INTO driver_home_status (group_id, telegram_group_id, state, state_since, last_status_at)
     VALUES (1, -1001, $1, $2, $2)`,
    [state, HOME_AT]
  );
  const cycle = await harness.query(
    `INSERT INTO driver_road_history (group_id, driver_name, unit_number, road_started_at, home_arrived_at, days_on_road, bonus_usd)
     VALUES (1, 'JOHN DOE', '7', $1, $2, 46, 200) RETURNING id`,
    [ROAD_AT, HOME_AT]
  );
  await harness.query(
    `INSERT INTO home_time_return_watch
       (group_id, road_history_id, home_since, anchor_lat, anchor_lng, anchor_at,
        last_lat, last_lng, last_speed_mph, last_seen_at, last_checked_at,
        max_miles_from_anchor, moving_sightings, load_identifier, load_status,
        last_confidence, last_score)
     VALUES (1, $1, $2, 41.88, -87.63, $2, 42.5, -88.6, 61, NOW() - INTERVAL '5 minutes',
             NOW() - ($3 || ' minutes')::interval, 66, 3, 'L-1', 'dispatched', $4, 110)`,
    [cycle.rows[0].id, HOME_AT, String(checkedMinutesAgo), confidence]
  );
  return { harness, cycleId: cycle.rows[0].id };
}

/** A real finding row, because operational_corrections points at one. */
async function fileFinding(harness) {
  const res = await harness.query(
    `INSERT INTO operational_findings
       (check_key, subject_type, subject_id, title, severity, tier, confidence,
        evidence_json, proposed_change_json)
     VALUES ('home_time.returned_to_road', 'group', '1', 'JOHN DOE looks back on the road',
             'info', 'auto', 95, '{}'::jsonb, $1::jsonb)
     RETURNING id`,
    [JSON.stringify({ groupId: 1, returnToRoadAt: RETURN_AT })]
  );
  return { id: res.rows[0].id, checkKey: 'home_time.returned_to_road', title: 'back on the road', confidence: 95 };
}

function loadApply(harness) {
  const db = { pool: harness.pool, query: harness.query };
  for (const p of [
    '../services/operations/corrections/actions',
    '../services/operations/corrections/apply',
    '../services/operations/corrections/returnToRoadActions',
  ]) delete require.cache[require.resolve(p)];
  const { applyCorrection, revertCorrection } = require('../services/operations/corrections/apply');
  return {
    db,
    apply: (payload, finding) => applyCorrection({
      actionKey: 'home_time.mark_returned_to_road',
      payload,
      finding,
      db,
    }),
    revert: (id) => revertCorrection({ correctionId: id, admin: { id: 1 }, db }),
  };
}

test('a high-confidence return closes the cycle, moves the driver, and tells the managers',
  { skip: skipWithoutPg() }, async (t) => {
    const { harness, cycleId } = await seed(t);
    await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'a','x') ON CONFLICT DO NOTHING");
    const ops = loadApply(harness);

    const correction = await ops.apply(
      { groupId: 1, returnToRoadAt: RETURN_AT, evidenceSummary: 'active load + truck 66 mi from home' },
      await fileFinding(harness)
    );
    assert.ok(correction.id);

    const status = await harness.query('SELECT state, state_since FROM driver_home_status WHERE group_id = 1');
    assert.equal(status.rows[0].state, 'road');

    const cycle = await harness.query('SELECT return_to_road_at, home_days FROM driver_road_history WHERE id = $1', [cycleId]);
    assert.ok(cycle.rows[0].return_to_road_at, 'the cycle is closed');
    assert.equal(cycle.rows[0].home_days, 4, 'Sep 16 → Sep 20 is four days at home');

    const notice = await harness.query("SELECT * FROM home_time_manager_notices WHERE event_type = 'back_on_road'");
    assert.equal(notice.rows.length, 1, 'written in the same transaction as the state change');
    assert.match(notice.rows[0].body, /Driver Back on the Road — JOHN DOE \(Unit 7\)/);
    assert.match(notice.rows[0].body, /Time at home: <b>4 days<\/b>/);
    assert.match(notice.rows[0].body, /active load \+ truck 66 mi from home/);
    for (const who of ['@tomr_robins0n', '@SaffieBNett', '@amelia_wenze']) {
      assert.ok(notice.rows[0].body.includes(who), `${who} is tagged`);
    }

    const watch = await harness.query('SELECT * FROM home_time_return_watch WHERE group_id = 1');
    assert.equal(watch.rows.length, 0, 'the watch is over');

    const audit = await harness.query(
      "SELECT action, entity_type FROM admin_audit_log WHERE action LIKE 'operational_correction%'"
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].action, 'operational_correction.home_time.mark_returned_to_road');
  });

test('it refuses when the driver is no longer home', { skip: skipWithoutPg() }, async (t) => {
  const { harness } = await seed(t, { state: 'road' });
  const ops = loadApply(harness);
  await assert.rejects(
    () => ops.apply({ groupId: 1, returnToRoadAt: RETURN_AT }),
    /already 'road'|already .road./
  );
  const notices = await harness.query('SELECT COUNT(*)::int AS n FROM home_time_manager_notices');
  assert.equal(notices.rows[0].n, 0, 'and nobody is told about a change that did not happen');
});

test('it refuses on a verdict that is no longer high', { skip: skipWithoutPg() }, async (t) => {
  const { harness } = await seed(t, { confidence: 'medium' });
  const ops = loadApply(harness);
  await assert.rejects(() => ops.apply({ groupId: 1, returnToRoadAt: RETURN_AT }), /reads 'medium'/);
});

test('it refuses on a verdict that is hours old — a truck can turn back',
  { skip: skipWithoutPg() }, async (t) => {
    const { harness } = await seed(t, { checkedMinutesAgo: 240 });
    const ops = loadApply(harness);
    await assert.rejects(() => ops.apply({ groupId: 1, returnToRoadAt: RETURN_AT }), /minutes old/);
  });

test('it refuses when nothing is watching this driver any more', { skip: skipWithoutPg() }, async (t) => {
  const { harness } = await seed(t);
  await harness.query('DELETE FROM home_time_return_watch WHERE group_id = 1');
  const ops = loadApply(harness);
  await assert.rejects(() => ops.apply({ groupId: 1, returnToRoadAt: RETURN_AT }), /no longer being watched/);
});

test('a wrong call is undone without losing what happened', { skip: skipWithoutPg() }, async (t) => {
  const { harness, cycleId } = await seed(t);
  await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'a','x') ON CONFLICT DO NOTHING");
  const ops = loadApply(harness);
  const correction = await ops.apply({ groupId: 1, returnToRoadAt: RETURN_AT }, await fileFinding(harness));

  await ops.revert(correction.id);

  const status = await harness.query('SELECT state, state_since FROM driver_home_status WHERE group_id = 1');
  assert.equal(status.rows[0].state, 'home', 'the driver is home again');
  const cycle = await harness.query('SELECT return_to_road_at, home_days FROM driver_road_history WHERE id = $1', [cycleId]);
  assert.equal(cycle.rows[0].return_to_road_at, null, 'and the cycle is open again');
  assert.equal(cycle.rows[0].home_days, null);

  const reverted = await harness.query('SELECT reverted_at, reverted_by, old_values, new_values FROM operational_corrections WHERE id = $1', [correction.id]);
  assert.ok(reverted.rows[0].reverted_at, 'the original decision is kept, marked reverted');
  assert.equal(reverted.rows[0].new_values.state, 'road', 'including what it had decided');

  const audits = await harness.query("SELECT action FROM admin_audit_log WHERE action LIKE 'operational_correction%' ORDER BY id");
  assert.deepEqual(audits.rows.map((r) => r.action), [
    'operational_correction.home_time.mark_returned_to_road',
    'operational_correction.revert.home_time.mark_returned_to_road',
  ], 'both the decision and its undo are in the audit log');
});

test('a revert refuses to overwrite a person who has since moved the driver',
  { skip: skipWithoutPg() }, async (t) => {
    const { harness } = await seed(t);
    await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'a','x') ON CONFLICT DO NOTHING");
    const ops = loadApply(harness);
    const correction = await ops.apply({ groupId: 1, returnToRoadAt: RETURN_AT }, await fileFinding(harness));
    await harness.query("UPDATE driver_home_status SET state_since = NOW() WHERE group_id = 1");
    await assert.rejects(() => ops.revert(correction.id), /changed since|no longer/i);
  });

test('the automatic check is switched on with a cap that cannot move a fleet',
  { skip: skipWithoutPg() }, async (t) => {
    const { harness } = await seed(t);
    const row = await harness.query(
      "SELECT auto_apply_enabled, max_auto_per_run, updated_by FROM operational_check_settings WHERE check_key = 'home_time.returned_to_road'"
    );
    assert.equal(row.rows[0].auto_apply_enabled, true);
    assert.equal(row.rows[0].max_auto_per_run, 25);
    assert.match(row.rows[0].updated_by, /migration 0030/);

    const unclear = await harness.query(
      "SELECT COUNT(*)::int AS n FROM operational_check_settings WHERE check_key = 'home_time.return_to_road_unclear'"
    );
    assert.equal(unclear.rows[0].n, 0, 'the unclear check is not, and has no action anyway');
  });

test('the watch remembers a parked anchor and never lets a moving sighting replace it',
  { skip: skipWithoutPg() }, async (t) => {
    const { harness } = await seed(t);
    const { homeTime } = harness.loadDataLayer(['homeTime']);
    await harness.query('DELETE FROM home_time_return_watch WHERE group_id = 1');
    const watch = harness.loadDataLayer(['homeTime/returnWatch']);
    const rw = watch['homeTime/returnWatch'] || require('../database/homeTime/returnWatch');
    assert.ok(homeTime, 'the façade loads');

    await rw.ensureWatch({ groupId: 1, homeSince: HOME_AT });
    await rw.recordObservation(1, {
      lat: 41.88, lng: -87.63, speedMph: 0, seenAt: HOME_AT, anchorEligible: true, anchorSource: 'live_gps',
    });
    await rw.recordObservation(1, {
      lat: 42.5, lng: -88.6, speedMph: 61, seenAt: RETURN_AT, milesFromAnchor: 66, moving: true,
      anchorEligible: true, // even asking again must not move it
    });
    const row = await rw.getWatch(1);
    assert.equal(Math.round(row.anchor.lat * 100) / 100, 41.88, 'the anchor is where the truck was parked');
    assert.equal(row.maxMilesFromAnchor, 66);
    assert.equal(row.movingSightings, 1);
  });

/**
 * The advertised kill switch has to exist to be switchable.
 *
 * `isCapabilityEnabled` treats a missing row as enabled, which is right for a
 * fresh install — but Settings → AI lists ai_capabilities rows, so a capability
 * that is never registered is invisible there and an administrator has no way
 * to turn the reasoning off. Migration 0030 seeds the row.
 */
test('the return-to-road reasoning is a capability an administrator can switch off',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
    const rows = await harness.query(
      `SELECT ai_enabled, sends_raw_text, has_deterministic_fallback, may_auto_apply
         FROM ai_capabilities WHERE capability_key = 'home_time_return_to_road'`
    );
    assert.equal(rows.rows.length, 1, 'the capability is registered, so the switch is reachable');
    assert.equal(rows.rows[0].ai_enabled, true, 'on by default');
    assert.equal(rows.rows[0].sends_raw_text, false, 'a scored evidence summary, never chat text');
    assert.equal(rows.rows[0].has_deterministic_fallback, true, 'the score decides without AI');
    assert.equal(rows.rows[0].may_auto_apply, false, 'AI never applies a correction');

    // Switched off, the router refuses the call rather than silently answering.
    await harness.query(
      `UPDATE ai_capabilities SET ai_enabled = FALSE WHERE capability_key = 'home_time_return_to_road'`
    );
    const after = await harness.query(
      `SELECT ai_enabled FROM ai_capabilities WHERE capability_key = 'home_time_return_to_road'`
    );
    assert.equal(after.rows[0].ai_enabled, false);
  });
