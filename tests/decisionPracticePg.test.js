/**
 * Each check's rehearsal record, against a real PostgreSQL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHECK = 'board.person_link';

// THE SHAPES THE JOURNAL ACTUALLY WRITES. A check in Suggest records `suggest`
// (never `act` — `applyMode` narrows it), a shadowed Autopilot check `act` with
// shadow. An earlier version of this file inserted `act` rows in Suggest mode,
// a row that cannot exist, and the reader passed against it while finding
// nothing in production.
async function decide(h, subjectId, verdict, { mode = 'suggest', shadow = false, daysAgo = 1, firstDaysAgo = null } = {}) {
  await h.query(
    `INSERT INTO operational_decisions
       (check_key, subject_type, subject_id, verdict, confidence, mode, shadow, reason,
        first_decided_at, last_decided_at)
     VALUES ($1, 'board_row', $2, $3, $4, $5, $6, 'r',
             NOW() - ($7 || ' days')::interval, NOW() - ($8 || ' days')::interval)`,
    [CHECK, String(subjectId), verdict, verdict === 'unknown' ? null : 90, mode, shadow,
      String(firstDaysAgo ?? daysAgo), String(daysAgo)]
  );
}

async function finding(h, subjectId, { status = 'open', dismissedBy = null } = {}) {
  const res = await h.query(
    `INSERT INTO operational_findings (check_key, subject_type, subject_id, title, status, dismissed_by, dismiss_reason)
     VALUES ($1, 'board_row', $2, 't', $3, $4, $5) RETURNING id`,
    [CHECK, String(subjectId), status, dismissedBy, dismissedBy ? 'not the same driver' : null]
  );
  return res.rows[0].id;
}

test('rehearsals are counted per check — flips, rejections and confirmations by a person',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
    // s1: rehearsed, and a PERSON applied the same correction.
    await decide(h, 1, 'suggest', { firstDaysAgo: 20, daysAgo: 2 });
    const f1 = await finding(h, 1, { status: 'applied' });
    await h.query(
      `INSERT INTO operational_corrections (finding_id, tier, action_key, subject_type, subject_id, initiator)
       VALUES ($1, 'auto', 'board.link_person', 'board_row', '1', 'admin:7')`, [f1]
    );
    // s2: rehearsed, then later held — it changed its mind.
    await decide(h, 2, 'suggest', { daysAgo: 10 });
    await decide(h, 2, 'hold', { daysAgo: 1 });
    // s3: rehearsed, and a person dismissed it.
    await decide(h, 3, 'suggest', { daysAgo: 3 });
    await finding(h, 3, { status: 'dismissed', dismissedBy: 'admin:7' });
    // s4: rehearsed in SHADOW while on autopilot — still a rehearsal.
    await decide(h, 4, 'act', { mode: 'autopilot', shadow: true, daysAgo: 1 });
    // s5: acted for real on autopilot — NOT a rehearsal.
    await decide(h, 5, 'act', { mode: 'autopilot', daysAgo: 1 });
    // s6: too old for the window.
    await decide(h, 6, 'suggest', { daysAgo: 45 });
    // s8: an `act` row NOT in shadow is a real action, whatever mode it names.
    await decide(h, 8, 'act', { mode: 'suggest', daysAgo: 1 });
    // s7: a system correction is not a person confirming.
    await decide(h, 7, 'suggest', { daysAgo: 1 });
    const f7 = await finding(h, 7, { status: 'applied' });
    await h.query(
      `INSERT INTO operational_corrections (finding_id, tier, action_key, subject_type, subject_id, initiator)
       VALUES ($1, 'auto', 'board.link_person', 'board_row', '7', 'system')`, [f7]
    );

    const { decisionPractice } = h.loadDataLayer(['decisionPractice']);
    const rows = await decisionPractice.summarisePractice({ sinceDays: 30 });
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.checkKey, CHECK);
    assert.equal(r.subjects, 5, 's1, s2, s3, s4, s7 — not a real act, not the old one');
    assert.equal(r.flips, 1);
    assert.equal(r.rejected, 1);
    assert.equal(r.confirmed, 1, 'only a person counts');
    assert.ok(new Date(r.firstAt) < new Date(r.lastAt));
  });

test('no rehearsals reads as an empty list', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { decisionPractice } = h.loadDataLayer(['decisionPractice']);
  assert.deepEqual(await decisionPractice.summarisePractice(), []);
});
