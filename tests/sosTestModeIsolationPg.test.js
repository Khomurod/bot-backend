/**
 * SOS real/test isolation — proves on a real database that the TEST flow
 * (/questions/test, /answers/test) can never read, count, block, or delete
 * REAL data, and vice versa: summaries, totals, duplicate detection, result
 * tokens, single deletes and clears are all scoped by is_test in SQL, and
 * rows that predate migration 0004 default to REAL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const M0003 = fs.readFileSync(path.resolve(__dirname, '../database/migrations/0003_sos_assessment.sql'), 'utf8');
const M0004 = fs.readFileSync(path.resolve(__dirname, '../database/migrations/0004_sos_test_mode.sql'), 'utf8');

let tokenSeq = 0;
function submissionInput(overrides = {}) {
  tokenSeq += 1;
  return {
    fullName: 'Real Person',
    nameNormalized: 'real person',
    department: 'hr',
    dispatchTeamId: null,
    dispatchTeamName: null,
    language: 'uz',
    contentVersion: 1,
    patternScores: { victim: 0, complaint: 0, waiting: 1, blame: 0, ownership: 6, builder: 3 },
    primaryPattern: 'ownership',
    secondaryPattern: 'builder',
    resultToken: `t${String(tokenSeq).padStart(4, '0')}${'0'.repeat(27)}`,
    duplicateConfirmed: false,
    clientIp: '127.0.0.1',
    isTest: false,
    answers: Array.from({ length: 10 }, (_, i) => ({
      questionKey: `hr_q${String(i + 1).padStart(2, '0')}`,
      optionKey: `hr_q${String(i + 1).padStart(2, '0')}_a`,
      pattern: 'ownership',
      weight: 1,
      position: i + 1,
    })),
    ...overrides,
  };
}

test('rows created before migration 0004 default to REAL mode', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  await harness.query(M0003); // the pre-test-mode world
  await harness.query(
    `INSERT INTO sos_submissions
       (full_name, name_normalized, department, language, content_version, pattern_scores,
        primary_pattern, result_token)
     VALUES ('Legacy Employee', 'legacy employee', 'hr', 'uz', 1, '{"ownership": 10}', 'ownership', $1)`,
    ['legacy'.padEnd(32, '0')],
  );
  await harness.query(M0004); // upgrade with existing data present

  const row = (await harness.query('SELECT is_test FROM sos_submissions')).rows[0];
  assert.equal(row.is_test, false, 'pre-existing submissions are classified as REAL');

  const { sosAssessment: db } = harness.loadDataLayer(['sosAssessment']);
  assert.equal((await db.getCompletionStats(false)).total, 1, 'legacy row counts as real');
  assert.equal((await db.getCompletionStats(true)).total, 0, 'legacy row never counts as test');
});

test('real and test data are fully isolated across every operation', { skip: skipWithoutPg(), timeout: 90000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  await harness.query(M0003);
  await harness.query(M0004);
  const { sosAssessment: db } = harness.loadDataLayer(['sosAssessment']);

  // Same person, same normalized name+department, once per mode.
  const real = await db.createSubmission(submissionInput({ resultToken: 'a'.repeat(32) }));
  const testSub = await db.createSubmission(submissionInput({
    fullName: 'REAL PERSON', // same normalized name on purpose
    isTest: true,
    resultToken: 'b'.repeat(32),
    primaryPattern: 'waiting',
    patternScores: { victim: 0, complaint: 0, waiting: 10, blame: 0, ownership: 0, builder: 0 },
    answers: submissionInput().answers.map((a) => ({ ...a, pattern: 'waiting' })),
  }));

  // ── Duplicate detection is mode-scoped ──
  assert.equal(await db.findDuplicate('real person', 'hr', false) !== null, true, 'real duplicate found in real mode');
  assert.equal(await db.findDuplicate('real person', 'hr', true) !== null, true, 'test duplicate found in test mode');
  // Cross-mode: creating either one did NOT block the other (both inserts above
  // succeeded); a fresh name has no duplicate in either mode.
  assert.equal(await db.findDuplicate('somebody new', 'hr', false), null);
  assert.equal(await db.findDuplicate('somebody new', 'hr', true), null);

  // Two same-mode submissions of the same name keep intended duplicate behavior.
  await db.createSubmission(submissionInput({ resultToken: 'c'.repeat(32) }));
  const realDup = await db.listSubmissions({ mode: 'real' });
  assert.ok(realDup.filter((r) => r.nameNormalized === 'real person').every((r) => r.duplicateCount === 2),
    'two REAL submissions of one name badge as duplicates');
  const testList = await db.listSubmissions({ mode: 'test' });
  assert.equal(testList[0].duplicateCount, 1, 'the TEST copy of the same name is NOT counted as their duplicate');

  // ── Result tokens are mode-scoped capabilities ──
  assert.ok(await db.getSubmissionByToken('a'.repeat(32), false), 'real token works on the real route');
  assert.equal(await db.getSubmissionByToken('a'.repeat(32), true), null, 'real token 404s on the test route');
  assert.ok(await db.getSubmissionByToken('b'.repeat(32), true), 'test token works on the test route');
  assert.equal(await db.getSubmissionByToken('b'.repeat(32), false), null, 'test token 404s on the real route');

  // ── Summaries and totals never mix ──
  const realRows = await db.getSummaryRows(false);
  assert.equal(realRows.submissions.length, 2);
  assert.ok(realRows.submissions.every((s) => s.primaryPattern === 'ownership'));
  assert.ok(!realRows.submissions.some((s) => s.primaryPattern === 'waiting'),
    'test respondents never reach the real summary');

  const testRows = await db.getSummaryRows(true);
  assert.equal(testRows.submissions.length, 1);
  assert.equal(testRows.submissions[0].primaryPattern, 'waiting');
  assert.ok(!testRows.submissions.some((s) => s.primaryPattern === 'ownership'),
    'real respondents never reach the test summary');

  assert.equal((await db.getCompletionStats(false)).total, 2, 'real totals exclude test');
  assert.equal((await db.getCompletionStats(true)).total, 1, 'test totals exclude real');

  // ── Admin list separation + explicit combined view ──
  assert.ok((await db.listSubmissions({ mode: 'real' })).every((r) => r.isTest === false));
  assert.ok((await db.listSubmissions({ mode: 'test' })).every((r) => r.isTest === true));
  assert.equal((await db.listSubmissions({ mode: 'all' })).length, 3);

  // ── Deleting an individual test submission leaves real records unchanged ──
  assert.equal(await db.deleteSubmission(testSub.id), true);
  assert.equal((await db.getCompletionStats(false)).total, 2);
  assert.equal((await db.getCompletionStats(true)).total, 0);

  // ── Clearing test data deletes all test rows and answers, touches nothing real ──
  await db.createSubmission(submissionInput({ isTest: true, resultToken: 'd'.repeat(32) }));
  await db.createSubmission(submissionInput({ isTest: true, resultToken: 'e'.repeat(32), fullName: 'Second Tester', nameNormalized: 'second tester' }));
  const clearedTest = await db.clearSubmissions(true);
  assert.equal(clearedTest, 2);
  assert.equal((await harness.query('SELECT COUNT(*)::int AS n FROM sos_submissions WHERE is_test')).rows[0].n, 0);
  assert.equal(
    (await harness.query('SELECT COUNT(*)::int AS n FROM sos_answers a JOIN sos_submissions s ON s.id = a.submission_id WHERE s.is_test')).rows[0].n,
    0,
    'all test answers removed',
  );
  assert.equal((await db.getCompletionStats(false)).total, 2, 'every real record survives a test clear');
  assert.ok(await db.getSubmissionByToken('a'.repeat(32), false), 'real result token still works after a test clear');

  // ── Clearing real data (separate, explicit) leaves test rows alone ──
  await db.createSubmission(submissionInput({ isTest: true, resultToken: 'f'.repeat(32) }));
  const clearedReal = await db.clearSubmissions(false);
  assert.equal(clearedReal, 2);
  assert.equal((await db.getCompletionStats(true)).total, 1, 'test data survives a real clear');
  assert.equal(real.id !== undefined, true);
});

test('the public summary payloads for each mode carry no identity fields', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  await harness.query(M0003);
  await harness.query(M0004);
  const { sosAssessment: db } = harness.loadDataLayer(['sosAssessment']);

  await db.createSubmission(submissionInput({ fullName: 'REAL-NAME-NEVER-PUBLIC', nameNormalized: 'x y', resultToken: 'a'.repeat(32) }));
  await db.createSubmission(submissionInput({ fullName: 'TEST-NAME-NEVER-PUBLIC', nameNormalized: 'z w', isTest: true, resultToken: 'b'.repeat(32) }));

  const { buildSummary } = require('../services/sosAssessment/aggregation');
  for (const isTest of [false, true]) {
    const summary = buildSummary({ open: true, ...(await db.getSummaryRows(isTest)) });
    const json = JSON.stringify(summary);
    assert.ok(!json.includes('NEVER-PUBLIC'), 'no name may reach a public summary');
    assert.ok(!json.includes('result_token') && !json.includes('resultToken'));
    assert.ok(!json.includes('client_ip') && !json.includes('127.0.0.1'));
    assert.equal(summary.total, 1, 'each mode sees exactly its own single submission');
    // The public summary is company-wide only: the department each respondent
    // picked is stored, but the summary query never even selects it.
    assert.ok(!json.includes('department') && !json.includes('"hr"'), 'no department data may be published');
    assert.ok(!json.includes('dispatch_team') && !json.includes('dispatchTeam'), 'no team data may be published');
    assert.deepEqual(
      Object.keys((await db.getSummaryRows(isTest)).submissions[0]),
      ['primaryPattern'],
      'the public summary reads one column per respondent and nothing else',
    );
  }
});
