'use strict';

/**
 * The ask pass's narrow reads, against a real PostgreSQL.
 *
 * October 2026, with the database transfer allowance nearly spent, the ask
 * pass stopped reading whole rows (`tests/askPassQueries.test.js` pins the
 * statements). What a narrower statement could quietly get wrong, and only a
 * real database can show:
 *   - the candidate list keeps the QUESTION ORDER before its limit, and the
 *     "already answered" variant stays inside that same first page;
 *   - one read of memories finds exactly what `findMemory` found, subject by
 *     subject — a numeric subject id included, compared as text;
 *   - the narrow rows still carry everything the pass uses: a remembered
 *     answer is still applied, and a hold still explains the question.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { fingerprintFor, memoryApplies } = require('../lib/control/fingerprint');

const ALL_MIGRATIONS = allMigrationsSql();
const STALE_UNIT = 'identity.stale_unit_assignment';
const TRUCKS = 'board.truck_disagrees_with_profile';

async function setup(t, modules) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return { h, ...h.loadDataLayer(modules) };
}

async function addFinding(h, {
  checkKey = STALE_UNIT, subjectId, severity = 'warning', tier = 'auto', daysOld = 1,
  status = 'open', snoozedHours = null, evidence = {}, proposedChange = { to: '322' },
}) {
  const res = await h.query(
    `INSERT INTO operational_findings
       (check_key, subject_type, subject_id, title, severity, tier, evidence_json, proposed_change_json,
        confidence, status, dismissed_by, dismiss_reason, snoozed_until, first_seen_at, last_seen_at)
     VALUES ($1, 'group', $2, 'about ' || $2, $3, $4, $5::jsonb, $6::jsonb, 80, $7,
             CASE WHEN $7 = 'dismissed' THEN 'admin:1' END,
             CASE WHEN $7 = 'dismissed' THEN 'not needed' END,
             CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() + ($8 || ' hours')::interval END,
             NOW() - ($9 || ' days')::interval, NOW())
     RETURNING id`,
    [checkKey, String(subjectId), severity, tier, JSON.stringify(evidence), JSON.stringify(proposedChange),
      status, snoozedHours, String(daysOld)]
  );
  return res.rows[0].id;
}

/** The fields the ask pass reads from a finding (`listAskCandidates`). */
const PASS_FIELDS = [
  'id', 'checkKey', 'subjectType', 'subjectId', 'title', 'severity', 'tier', 'evidence',
  'proposedChange', 'confidence', 'status', 'firstSeenAt', 'lastSeenAt',
];

test('the candidates come in QUESTION ORDER before the limit, open and awake only, with what the pass reads', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, operationalFindings: store } = await setup(t, ['operationalFindings']);
  await addFinding(h, { subjectId: 'new-warning', daysOld: 1 });
  await addFinding(h, { subjectId: 'old-warning', daysOld: 9 });
  await addFinding(h, { subjectId: 'serious', severity: 'serious' });
  await addFinding(h, { checkKey: 'home_time.road_bonus_review', subjectId: 'bonus', daysOld: 20 });
  await addFinding(h, { subjectId: 'dismissed', status: 'dismissed', daysOld: 30 });
  await addFinding(h, { subjectId: 'snoozed', snoozedHours: 5, daysOld: 30 });

  const page = await store.listAskCandidates({ limit: 2 });
  assert.deepEqual(page.map((f) => f.subjectId), ['bonus', 'serious'],
    'the held bonus is on the first page however long ago it was first seen');

  const all = await store.listAskCandidates({ limit: 10 });
  const admin = await store.listFindings({ status: 'open', limit: 10, order: 'ask' });
  assert.deepEqual(all.map((f) => f.subjectId), ['bonus', 'serious', 'old-warning', 'new-warning']);
  assert.deepEqual(all.map((f) => f.id), admin.map((f) => f.id), 'the same rows the whole-row reader returns');
  all.forEach((f, i) => {
    for (const field of PASS_FIELDS) assert.deepEqual(f[field], admin[i][field], field);
    // Not read, so not there — rather than present and wrong.
    for (const field of ['resolvedAt', 'dismissedAt', 'dismissedBy', 'dismissReason', 'snoozedUntil']) {
      assert.equal(f[field], undefined, field);
    }
  });
});

test('ONLY WHAT WAS ANSWERED, and only from the same first page the full read would consider', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, operationalFindings: store, controlKnowledge } = await setup(t, ['operationalFindings', 'controlKnowledge']);
  const remember = (subjectId, checkKey = STALE_UNIT) => controlKnowledge.rememberAnswer({
    checkKey, subjectType: 'group', subjectId, answerAction: 'dismiss', evidenceFingerprint: 'f'.repeat(32),
  });
  await addFinding(h, { subjectId: 'a', daysOld: 9 }); // first page, answered
  await addFinding(h, { subjectId: 'b', daysOld: 8 }); // first page, answered about ANOTHER check
  await addFinding(h, { subjectId: 'c', daysOld: 7 }); // first page, answer taken back
  await addFinding(h, { subjectId: 'd', daysOld: 1 }); // answered, but not on the first page
  await remember('a');
  await remember('b', TRUCKS);
  await controlKnowledge.revokeMemory((await remember('c')).id);
  await remember('d');
  await remember('no-finding');

  const page = await store.listAskCandidates({ limit: 3, rememberedOnly: true });
  assert.deepEqual(page.map((f) => f.subjectId), ['a'],
    'a finding outside the first page waits, exactly as it did when every candidate was read');
  for (const field of PASS_FIELDS) assert.notEqual(page[0][field], undefined, field);

  const wider = await store.listAskCandidates({ limit: 10, rememberedOnly: true });
  assert.deepEqual(wider.map((f) => f.subjectId), ['a', 'd']);
});

test('ONE READ OF MEMORIES finds what findMemory found, subject by subject — and nothing else', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge } = await setup(t, ['controlKnowledge']);
  const finding = {
    checkKey: TRUCKS, subjectType: 'group', subjectId: 49, status: 'open',
    evidence: { profileUnit: '310', boardTruck: '311' },
  };
  const answer = (subjectId, patch = {}) => controlKnowledge.rememberAnswer({
    checkKey: TRUCKS, subjectType: 'group', subjectId, answerAction: 'dismiss',
    answerText: 'He swapped trucks.', evidenceFingerprint: fingerprintFor(finding),
    confirmedBy: 'telegram:2117922421', ...patch,
  });
  await answer('49');
  await answer('50', { answerAction: 'approve' });
  await controlKnowledge.revokeMemory((await answer('51')).id);
  await answer('49', { checkKey: STALE_UNIT }); // the same subject id under another check
  await controlKnowledge.rememberAnswer({
    checkKey: TRUCKS, subjectType: 'person', subjectId: '49', answerAction: 'dismiss', evidenceFingerprint: 'x',
  });

  const subjects = [49, 50, 51, 52].map((subjectId) => ({ ...finding, subjectId }));
  const batch = await controlKnowledge.findMemoriesFor(subjects);
  assert.equal(batch.length, 2, 'the answered subject and the approval; revoked, unanswered and other checks are not read');
  for (const s of subjects) {
    // eslint-disable-next-line no-await-in-loop
    const one = await controlKnowledge.findMemory({ ...s, subjectId: String(s.subjectId) });
    const fromBatch = batch.find((m) => m.subjectId === String(s.subjectId)) || null;
    assert.equal(fromBatch?.id ?? null, one?.id ?? null, `subject ${s.subjectId}`);
    if (!one) continue;
    for (const field of ['id', 'checkKey', 'subjectType', 'subjectId', 'answerAction', 'answerText',
      'evidenceFingerprint', 'confirmedBy', 'expiresAt']) {
      assert.deepEqual(fromBatch[field], one[field], field);
    }
  }
  assert.equal(memoryApplies(finding, batch.find((m) => m.subjectId === '49')), true,
    'the narrow row is enough to apply the answer');
  assert.deepEqual(await controlKnowledge.findMemoriesFor([]), []);
});

/**
 * The pass with the reads this change narrowed — candidates, memories, holds —
 * and the settings and suppression reads on the real schema. Stubbed: the two
 * counts that decide whether it may ask, the per-check modes, and the sending.
 */
function passDeps(loaded, { outstanding, notified }) {
  // eslint-disable-next-line global-require
  const { defaultDeps } = require('../services/control/askPass');
  return {
    ...defaultDeps(),
    settings: loaded.controlSettings,
    findings: loaded.operationalFindings,
    knowledge: loaded.controlKnowledge,
    decisions: loaded.operationalDecisions,
    notices: {
      countUnansweredQuestions: async () => outstanding,
      noticeSentWithin: loaded.operationalNotifications.noticeSentWithin,
    },
    digest: { countQuestionsAskedSince: async () => 0 },
    loadCheckSettings: async () => new Map(),
    takeDecision: async () => ({ id: 1 }),
    notify: async (n) => { notified.push(n); return { recorded: true }; },
  };
}

const LAYER = ['controlSettings', 'operationalFindings', 'controlKnowledge', 'operationalDecisions', 'operationalNotifications'];

test('A TICK THAT CANNOT ASK still closes the answered finding on the real schema', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, ...loaded } = await setup(t, LAYER);
  const evidence = { profileUnit: '310', boardTruck: '311' };
  const answeredId = await addFinding(h, { checkKey: TRUCKS, subjectId: '49', tier: 'approval', evidence });
  const otherId = await addFinding(h, { checkKey: TRUCKS, subjectId: '50', tier: 'approval', evidence });
  await loaded.controlKnowledge.rememberAnswer({
    checkKey: TRUCKS, subjectType: 'group', subjectId: '49', answerAction: 'dismiss',
    answerText: 'He swapped trucks.', confirmedBy: 'telegram:1',
    evidenceFingerprint: fingerprintFor({ checkKey: TRUCKS, evidence }),
  });

  const notified = [];
  const { runAskPass } = require('../services/control/askPass'); // eslint-disable-line global-require
  const got = await runAskPass({}, passDeps(loaded, { outstanding: 5, notified }));
  assert.equal(got.reason, 'waiting_for_answers');
  assert.equal(got.skipped.remembered, 1);
  assert.equal(got.considered, null, 'the candidates are not read just to be counted');
  assert.equal(notified.length, 0);

  const status = await h.query('SELECT id, status, dismiss_reason FROM operational_findings ORDER BY id');
  assert.deepEqual(status.rows.map((r) => [r.id, r.status]), [[answeredId, 'dismissed'], [otherId, 'open']]);
  assert.match(status.rows[0].dismiss_reason, /He swapped trucks/);
  const memory = await loaded.controlKnowledge.findMemory({ checkKey: TRUCKS, subjectType: 'group', subjectId: '49' });
  assert.equal(memory.timesApplied, 1);
});

test('A FULL TICK on the real schema asks with the hold\'s reason, from the narrow reads', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, ...loaded } = await setup(t, LAYER);
  const bonusId = await addFinding(h, {
    checkKey: 'home_time.road_bonus_review', subjectId: '7', tier: 'approval', daysOld: 3,
    evidence: { roadHistoryId: 7, daysOnRoad: 45, bonusUsd: 1200, driverName: 'TEST DRIVER' },
    proposedChange: { roadHistoryId: 7 },
  });
  await loaded.operationalDecisions.recordDecision({
    checkKey: 'home_time.road_bonus_review', subjectType: 'group', subjectId: '7',
    verdict: 'hold', confidence: 60, mode: 'autopilot', reason: 'confidence 60 below the floor of 70',
    evidence: { padding: 'x'.repeat(2000) },
  });

  const notified = [];
  const { runAskPass } = require('../services/control/askPass'); // eslint-disable-line global-require
  const got = await runAskPass({}, passDeps(loaded, { outstanding: 0, notified }));
  assert.equal(got.asked, 1);
  assert.equal(got.considered, 1);
  assert.equal(notified[0].findingId, bonusId);
  assert.match(notified[0].lines.join(' '), /not sure enough/i, 'the hold, read in five columns, still explains it');
  assert.match(notified[0].lines.join(' '), /45 days on the road, \$1200 bonus/);
});
