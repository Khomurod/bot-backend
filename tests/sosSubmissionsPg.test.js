/**
 * SOS assessment — PostgreSQL integration tests: migrations 0003 + 0004 apply
 * idempotently on the real schema, the submission transaction stores full
 * snapshots, duplicates are detectable, deletes cascade, and the aggregate
 * queries feed the anonymous summary correctly. (Real/test isolation has its
 * own dedicated suite: tests/sosTestModeIsolationPg.test.js.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const MIGRATIONS = ['0003_sos_assessment.sql', '0004_sos_test_mode.sql'].map((name) => fs.readFileSync(
  path.resolve(__dirname, '../database/migrations', name),
  'utf8',
));

async function applySosMigrations(harness) {
  for (const sql of MIGRATIONS) await harness.query(sql);
}

function submissionInput(overrides = {}) {
  return {
    fullName: 'Test Employee',
    nameNormalized: 'test employee',
    department: 'hr',
    dispatchTeamId: null,
    dispatchTeamName: null,
    language: 'uz',
    contentVersion: 1,
    patternScores: { victim: 0, complaint: 1, waiting: 2, blame: 0, ownership: 4, builder: 3 },
    primaryPattern: 'ownership',
    secondaryPattern: 'builder',
    resultToken: `tok_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`,
    duplicateConfirmed: false,
    clientIp: '127.0.0.1',
    answers: Array.from({ length: 10 }, (_, i) => ({
      questionKey: `hr_q${String(i + 1).padStart(2, '0')}`,
      optionKey: `hr_q${String(i + 1).padStart(2, '0')}_a`,
      pattern: i < 4 ? 'ownership' : 'builder',
      weight: 1,
      position: i + 1,
    })),
    ...overrides,
  };
}

test('migrations 0003+0004 apply twice on the real schema and seed the settings row', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  await applySosMigrations(harness);
  await applySosMigrations(harness); // idempotency: re-run must be a no-op

  const settings = await harness.query('SELECT * FROM sos_settings');
  assert.equal(settings.rows.length, 1);
  assert.equal(settings.rows[0].is_open, true);
  assert.equal(settings.rows[0].test_is_open, true, '0004 adds the independent test switch');

  const { sosAssessment: db } = harness.loadDataLayer(['sosAssessment']);
  assert.equal((await db.getSettings()).isOpen, true);
  // Each switch toggles independently of the other.
  assert.equal((await db.setOpen(false, false)).isOpen, false);
  assert.equal((await db.getSettings()).testIsOpen, true, 'closing REAL leaves TEST open');
  assert.equal((await db.setOpen(false, true)).testIsOpen, false);
  assert.equal((await db.getSettings()).isOpen, false, 'toggling TEST leaves REAL as it was');
  assert.equal((await db.setOpen(true, false)).isOpen, true);
});

test('submission lifecycle: transactional insert, snapshots, duplicates, cascade delete, aggregates', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  await applySosMigrations(harness);
  const { sosAssessment: db } = harness.loadDataLayer(['sosAssessment']);

  const created = await db.createSubmission(submissionInput());
  assert.ok(created.id > 0 && created.createdAt instanceof Date);

  // Full snapshot persisted, including per-answer pattern + weight.
  const detail = await db.getSubmissionDetail(created.id);
  assert.equal(detail.fullName, 'Test Employee');
  assert.equal(detail.primaryPattern, 'ownership');
  assert.equal(detail.secondaryPattern, 'builder');
  assert.deepEqual(detail.patternScores.ownership, 4);
  assert.equal(detail.answers.length, 10);
  assert.deepEqual(detail.answers[0], {
    questionKey: 'hr_q01', optionKey: 'hr_q01_a', pattern: 'ownership', weight: 1, position: 1,
  });

  // Token view excludes identity fields.
  const byToken = await db.getSubmissionByToken(submissionInput().resultToken.slice(0, 8), false);
  assert.equal(byToken, null);
  const token = (await harness.query('SELECT result_token FROM sos_submissions WHERE id = $1', [created.id])).rows[0].result_token;
  const view = await db.getSubmissionByToken(token, false);
  assert.equal(view.primaryPattern, 'ownership');
  assert.equal(view.fullName, undefined);
  assert.equal(view.clientIp, undefined);

  // Duplicate detection by normalized name + department.
  assert.ok(await db.findDuplicate('test employee', 'hr', false));
  assert.equal(await db.findDuplicate('test employee', 'safety', false), null);
  assert.equal(await db.findDuplicate('another person', 'hr', false), null);

  // A failed insert rolls back the submission row too (unique token reuse).
  await assert.rejects(db.createSubmission(submissionInput({ resultToken: token })));
  assert.equal((await harness.query('SELECT COUNT(*)::int AS n FROM sos_submissions')).rows[0].n, 1);

  // Dispatch submission with a team snapshot; aggregates group correctly.
  const teamId = (await harness.query("INSERT INTO dispatch_teams (name) VALUES ('Team Alpha') RETURNING id")).rows[0].id;
  await db.createSubmission(submissionInput({
    fullName: 'Dispatcher One',
    nameNormalized: 'dispatcher one',
    department: 'dispatch',
    dispatchTeamId: teamId,
    dispatchTeamName: 'Team Alpha',
    primaryPattern: 'waiting',
    secondaryPattern: null,
    answers: submissionInput().answers.map((a, i) => ({
      ...a,
      questionKey: `dispatch_q${String(i + 1).padStart(2, '0')}`,
      optionKey: `dispatch_q${String(i + 1).padStart(2, '0')}_b`,
      pattern: 'waiting',
    })),
  }));

  // The public summary is company-wide: one primary pattern per respondent and
  // nothing else — no department, team, answer or option data is even selected.
  const summaryRows = await db.getSummaryRows(false);
  assert.equal(summaryRows.submissions.length, 2);
  assert.deepEqual(Object.keys(summaryRows), ['submissions']);
  assert.deepEqual(
    summaryRows.submissions.map((s) => s.primaryPattern).sort(),
    ['ownership', 'waiting'],
  );
  assert.ok(summaryRows.submissions.every((s) => Object.keys(s).length === 1));
  assert.ok(!JSON.stringify(summaryRows).includes('Team Alpha'), 'no team snapshot in the public rows');

  // Admin list + filters + duplicate badge counts.
  const all = await db.listSubmissions();
  assert.equal(all.length, 2);
  assert.ok(all.every((row) => row.duplicateCount === 1));
  assert.equal((await db.listSubmissions({ department: 'dispatch' })).length, 1);
  assert.equal((await db.listSubmissions({ pattern: 'builder' })).length, 1);
  assert.equal((await db.listSubmissions({ search: 'dispatcher' })).length, 1);
  // Teams filter by their exact snapshotted NAME, not by the legacy FK id.
  assert.equal((await db.listSubmissions({ dispatchTeamName: 'Team Alpha' })).length, 1);
  assert.equal((await db.listSubmissions({ dispatchTeamName: 'Nobody / Nowhere' })).length, 0);

  const stats = await db.getCompletionStats(false);
  assert.equal(stats.total, 2);
  assert.equal(stats.byDepartment.hr, 1);
  assert.deepEqual(stats.byTeam, [{ teamName: 'Team Alpha', count: 1 }]);
  assert.ok(stats.lastSubmissionAt instanceof Date);

  // FK ON DELETE SET NULL keeps history when a team disappears.
  await harness.query('DELETE FROM dispatch_teams WHERE id = $1', [teamId]);
  const afterTeamDelete = await db.listSubmissions({ department: 'dispatch' });
  assert.equal(afterTeamDelete[0].dispatchTeamId, null);
  assert.equal(afterTeamDelete[0].dispatchTeamName, 'Team Alpha');

  // Cascade delete removes answers with the submission.
  assert.equal(await db.deleteSubmission(created.id), true);
  assert.equal((await harness.query('SELECT COUNT(*)::int AS n FROM sos_answers')).rows[0].n, 10);
  assert.equal(await db.deleteSubmission(created.id), false);

  // Mode-scoped clear requires an explicit boolean and wipes only that mode.
  await assert.rejects(() => db.clearSubmissions(), /explicit boolean/);
  assert.equal(await db.clearSubmissions(false), 1);
  assert.equal((await harness.query('SELECT COUNT(*)::int AS n FROM sos_answers')).rows[0].n, 0);
});
