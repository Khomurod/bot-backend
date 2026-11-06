/**
 * The findings lifecycle, against a real PostgreSQL.
 *
 * The rules being pinned here are the ones that decide whether an operations
 * page stays trustworthy or becomes noise people scroll past:
 *   - a recurring condition updates ONE row and keeps its first_seen_at;
 *   - a human's dismissal outranks the sweep;
 *   - auto-resolve only touches checks that actually ran;
 *   - a dismissal without a reason is refused by the database, not the route.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const MIGRATION_0016 = fs.readFileSync(
  path.resolve(__dirname, '..', 'database', 'migrations', '0016_operational_findings.sql'),
  'utf8'
);

function loadStore(harness) {
  return harness.loadDataLayer(['operationalFindings']).operationalFindings;
}

async function harnessWithFindings(t) {
  return createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
}

const BASE = {
  checkKey: 'identity.duplicate_unit',
  subjectType: 'unit',
  subjectId: '001',
  title: "Unit 001 is on 4 active driver groups",
  severity: 'serious',
  tier: 'warning',
  evidence: { groups: [11, 12, 13, 14] },
};

test('the migration applies to the baseline and re-applies as a no-op', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  await harness.query(MIGRATION_0016);
  const cols = await harness.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'operational_findings'`
  );
  assert.ok(cols.rows[0].n > 15);
});

test('a recurring condition updates one row and keeps its first_seen_at', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);

  const first = await store.upsertFinding(BASE);
  await harness.query(
    "UPDATE operational_findings SET first_seen_at = '2026-06-01T00:00:00Z' WHERE id = $1", [first.id]
  );
  const refiled = await store.upsertFinding({ ...BASE, title: 'Unit 001 is on 3 active driver groups' });
  assert.deepEqual(Object.keys(refiled), ['id'], 'the id alone comes back — the finding is not echoed whole');
  const second = await store.getFindingById(refiled.id);

  assert.equal(second.id, first.id, 'one row, not two');
  assert.equal(second.title, 'Unit 001 is on 3 active driver groups', 'refreshed');
  assert.equal(new Date(second.firstSeenAt).toISOString().slice(0, 10), '2026-06-01',
    '"this has been true since June" is the most useful thing it knows');

  const n = await harness.query('SELECT COUNT(*)::int AS n FROM operational_findings');
  assert.equal(n.rows[0].n, 1);
});

test('a resolved finding re-opens when the condition returns', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);

  const filed = await store.upsertFinding(BASE);
  await store.resolveClearedFindings([BASE.checkKey], []);
  assert.equal((await store.getFindingById(filed.id)).status, 'resolved');

  const again = await store.getFindingById((await store.upsertFinding(BASE)).id);
  assert.equal(again.status, 'open');
  assert.equal(again.resolvedAt, null);
});

test("a human's dismissal outranks the sweep", { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);

  const filed = await store.getFindingById((await store.upsertFinding(BASE)).id);
  await store.dismissFinding(filed.id, { dismissedBy: 'admin', reason: 'Unit 001 is a placeholder; known.' });

  const after = await store.getFindingById((await store.upsertFinding(BASE)).id);
  assert.equal(after.status, 'dismissed', 'the sweep must not overrule the one person who looked');
  assert.equal(after.dismissReason, 'Unit 001 is a placeholder; known.');
  assert.ok(new Date(after.lastSeenAt) >= new Date(filed.lastSeenAt), 'but the record stays honest');
});

test('a dismissal without a reason is refused by the database', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const filed = await loadStore(harness).upsertFinding(BASE);
  await assert.rejects(
    () => harness.query("UPDATE operational_findings SET status = 'dismissed' WHERE id = $1", [filed.id]),
    /operational_findings_dismissal_has_reason/
  );
});

test('auto-resolve never touches a check that did not run', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);

  await store.upsertFinding(BASE);
  const other = await store.upsertFinding({
    ...BASE, checkKey: 'home_time.ghost_home_status', subjectType: 'group', subjectId: '3',
  });

  // Only the identity check ran this sweep, and it reported nothing.
  const resolved = await store.resolveClearedFindings(['identity.duplicate_unit'], []);

  assert.equal(resolved, 1);
  assert.equal((await store.getFindingById(other.id)).status, 'open',
    'a Samsara outage must not clear findings it never evaluated');
});

test('what the sweep just filed is kept; what it did not is resolved', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);

  const stillTrue = await store.upsertFinding(BASE);
  await store.upsertFinding({ ...BASE, subjectId: '777', title: 'Unit 777 is on 2 groups' });

  const resolved = await store.resolveClearedFindings([BASE.checkKey], [stillTrue.id]);

  assert.equal(resolved, 1);
  assert.equal((await store.getFindingById(stillTrue.id)).status, 'open');
});

test('a snoozed finding leaves the list without pretending it went away', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);

  const filed = await store.upsertFinding(BASE);
  await store.snoozeFinding(filed.id, new Date(Date.now() + 86400000));

  assert.equal((await store.listFindings()).length, 0);
  assert.equal((await store.listFindings({ includeSnoozed: true })).length, 1);
  assert.equal((await store.getFindingById(filed.id)).status, 'open', 'still open, just hidden');
  assert.equal((await store.summariseFindings()).total, 0);
});

test('the summary is zero-filled so a severity never vanishes', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);
  await store.upsertFinding(BASE);

  const summary = await store.summariseFindings();
  assert.deepEqual(summary, { info: 0, warning: 0, serious: 1, total: 1 });
});

test('findings list worst-first', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);
  await store.upsertFinding({ ...BASE, subjectId: 'a', severity: 'info' });
  await store.upsertFinding({ ...BASE, subjectId: 'b', severity: 'serious' });
  await store.upsertFinding({ ...BASE, subjectId: 'c', severity: 'warning' });

  const listed = await store.listFindings();
  assert.deepEqual(listed.map((f) => f.severity), ['serious', 'warning', 'info']);
});

test('the legacy duplicate-unit history is carried across with its state', { skip: skipWithoutPg() }, async (t) => {
  // A bare harness so 0016's import runs against rows seeded before it.
  const harness = await createPgHarness(t, { extraDdl: allMigrationsSql((n) => n < '0016') });
  await harness.query(
    `INSERT INTO duplicate_unit_reports (unit_number, report_type, group_ids, group_names, detail, severity, status, first_seen_at)
     VALUES ('777','duplicate_unit','{34,182723}','{"A","B"}','Unit 777 is on 2 active driver groups','warning','open','2026-06-01T10:00:00Z'),
            ('313','name_mismatch','{31}','{"C"}','Samsara label lists a different driver','warning','resolved','2026-07-02T10:00:00Z')`
  );

  await harness.query(MIGRATION_0016);
  await harness.query(MIGRATION_0016); // a second boot must not duplicate

  const rows = await harness.query(
    'SELECT check_key, subject_id, status, first_seen_at FROM operational_findings ORDER BY subject_id'
  );
  assert.equal(rows.rows.length, 2, 'imported once, not twice');
  const open = rows.rows.find((r) => r.subject_id === '777');
  assert.equal(open.check_key, 'legacy.duplicate_unit');
  assert.equal(open.status, 'open');
  assert.equal(new Date(open.first_seen_at).toISOString().slice(0, 10), '2026-06-01',
    'the fleet\'s existing detection history is not reset to zero');
  assert.equal(rows.rows.find((r) => r.subject_id === '313').status, 'resolved');
});

test('an APPLIED finding reported again after a gap is a recurrence: open again, so its repair can run', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);

  const filed = await store.upsertFinding(BASE);
  // Applied, and then — the repair worked — not reported for an hour.
  await harness.query(
    "UPDATE operational_findings SET status = 'applied', last_seen_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [filed.id]
  );
  assert.equal(await store.resolveClearedFindings([BASE.checkKey], []), 0, 'an applied finding is never resolved — its history stays');

  // The same condition on the same subject again (unit 077, November 2026).
  const again = await store.getFindingById((await store.upsertFinding(BASE)).id);
  assert.equal(again.id, filed.id, 'one row per condition, first_seen_at kept');
  assert.equal(again.status, 'open');
});

test('an APPLIED finding reported on the very next sweep stays applied — a repair that did not work is not retried', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWithFindings(t);
  const store = loadStore(harness);

  const filed = await store.upsertFinding(BASE);
  await harness.query(
    "UPDATE operational_findings SET status = 'applied', last_seen_at = NOW() - INTERVAL '15 minutes' WHERE id = $1", [filed.id]
  );
  await store.upsertFinding(BASE);
  assert.equal((await store.getFindingById(filed.id)).status, 'applied');
  // A dismissal is a person's answer and is never reopened by a gap.
  await harness.query(
    "UPDATE operational_findings SET status = 'dismissed', dismissed_by = 'admin', dismiss_reason = 'known', last_seen_at = NOW() - INTERVAL '2 days' WHERE id = $1", [filed.id]
  );
  await store.upsertFinding(BASE);
  assert.equal((await store.getFindingById(filed.id)).status, 'dismissed');
});

test('migration 0094 reopens only the applied findings a sweep kept reporting after their correction', { skip: skipWithoutPg() }, async (t) => {
  const before = allMigrationsSql((name) => !name.startsWith('0094_'));
  const harness = await createPgHarness(t, { extraDdl: before });
  const m0094 = fs.readFileSync(path.resolve(__dirname, '..', 'database', 'migrations', '0094_reopen_applied_findings_still_reported.sql'), 'utf8');
  const insert = async (subjectId, lastSeen, appliedAt) => {
    const f = (await harness.query(
      `INSERT INTO operational_findings (check_key, subject_type, subject_id, title, severity, tier, status, last_seen_at)
       VALUES ('identity.unit_fleet_behind_profile', 'group', $1, 't', 'info', 'auto', 'applied', $2) RETURNING id`,
      [subjectId, lastSeen]
    )).rows[0].id;
    await harness.query(
      `INSERT INTO operational_corrections (finding_id, action_key, tier, subject_type, subject_id, initiator, applied_at)
       VALUES ($1, 'identity.sync_unit_fleet', 'auto', 'group', $2, 'system', $3)`,
      [f, subjectId, appliedAt]
    );
    return f;
  };
  const hour = 3600 * 1000;
  const iso = (ms) => new Date(Date.now() - ms).toISOString();
  const stuck = await insert('860440', iso(0.1 * hour), iso(14 * hour));   // re-reported long after its correction
  const fresh = await insert('70', iso(0.1 * hour), iso(0.15 * hour));     // corrected minutes ago
  const gone = await insert('130', iso(30 * hour), iso(60 * 24 * hour));   // not reported for a day

  await harness.query(m0094);
  await harness.query(m0094); // idempotent
  const status = async (id) => (await harness.query('SELECT status FROM operational_findings WHERE id = $1', [id])).rows[0].status;
  assert.equal(await status(stuck), 'open');
  assert.equal(await status(fresh), 'applied', 'a correction minutes old has not had a sweep to prove it yet');
  assert.equal(await status(gone), 'applied', 'not seen for a day: the next sweep resolves it');
});
