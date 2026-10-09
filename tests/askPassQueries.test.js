'use strict';

/**
 * What one tick of the control ask pass costs the database.
 *
 * October 2026, with the hosted database's transfer allowance nearly spent:
 * every fifteen minutes (`control_ask_pass`) the pass read up to 200 WHOLE
 * decision rows for the holds (21 columns, three of them JSON), a hundred whole
 * findings, and then asked `control_knowledge` once PER FINDING — up to a
 * hundred more statements, each describing sixteen columns to say "nothing
 * remembered". It did all of that BEFORE the two checks that end most ticks:
 * the standing cap on unanswered questions and the daily limit.
 *
 * The real data layer runs here over a fake `pg` that records every statement.
 * The two calls that SEND — the journal entry and the notice — are stubbed:
 * they run at most twice a day, and what a tick costs is what it READS.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fingerprintFor } = require('../lib/control/fingerprint');

const sent = [];
const textOf = (q) => (typeof q === 'string' ? q : q?.text || '');
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

/** What the fake database holds for the test that is running. */
let world = {};

const rows = (list) => ({ rows: list, rowCount: list.length });
const sameSubject = (a, b) => a.check_key === b.check_key
  && a.subject_type === b.subject_type && a.subject_id === b.subject_id;

function respond(text, params = []) {
  const sql = oneLine(text);
  if (/FROM control_settings/.test(sql)) {
    return rows([{
      enabled: true, max_questions_per_pass: 5, repeat_after_hours: 72, clarify_limit: 1, max_questions_per_day: 2,
    }]);
  }
  if (/FROM operational_notifications/.test(sql)) {
    if (/notice_key LIKE/.test(sql)) return rows([]); // nothing asked recently
    if (/parent_notice_id IS NULL/.test(sql)) return rows([{ n: world.askedToday }]);
    return rows([{ n: world.outstanding }]);
  }
  if (/FROM operational_check_settings/.test(sql)) return rows(world.checkSettings);
  if (/^UPDATE operational_findings/.test(sql)) return rows([{ id: params[0], status: 'dismissed' }]);
  if (/^UPDATE control_knowledge/.test(sql)) return rows([{ id: params[0] }]);
  if (/FROM operational_findings/.test(sql)) {
    // A read that names control_knowledge wants only the candidates somebody
    // has already answered; anything else is the whole candidate list.
    if (/control_knowledge/.test(sql)) {
      return rows(world.findings.filter((f) => world.memories.some((m) => sameSubject(f, m))));
    }
    return rows(world.findings);
  }
  if (/FROM operational_decisions/.test(sql)) return rows(world.holds);
  if (/FROM control_knowledge/.test(sql)) return rows(world.memories);
  return rows([]);
}

class FakeClient {
  async query(q, params) { sent.push(oneLine(textOf(q))); return respond(textOf(q), params); }
  release() {}
}
class FakePool {
  on() {}
  async query(q, params) { sent.push(oneLine(textOf(q))); return respond(textOf(q), params); }
  async connect() { return new FakeClient(); }
}
require.cache[require.resolve('pg')] = { exports: { Pool: FakePool } };

// eslint-disable-next-line global-require
const { runAskPass, defaultDeps } = require('../services/control/askPass');
const controlSettings = require('../database/controlSettings');

const WHOLE_ROW = /RETURNING \*|SELECT \*|SELECT [a-z_]+\.\*/i;
const ASK_TABLES = ['operational_findings', 'operational_decisions', 'control_knowledge'];
/** The table a statement is about: the first one it reads, or the one it writes. */
const tableOf = (s) => (s.match(/^(?:UPDATE|INSERT INTO)\s+([a-z_]+)/i) || s.match(/\bFROM\s+([a-z_]+)/i) || [])[1];

function findingRow(over = {}) {
  return {
    id: 11,
    check_key: 'identity.stale_unit_assignment',
    subject_type: 'group',
    subject_id: '49',
    title: 'The profile names a different truck',
    severity: 'warning',
    tier: 'auto',
    evidence_json: { personId: 5, profileUnit: '322', recordedUnit: '310' },
    proposed_change_json: { personId: 5, to: '322', groupId: 49 },
    confidence: 90,
    status: 'open',
    first_seen_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
    last_seen_at: new Date().toISOString(),
    ...over,
  };
}

/** The finding as the data layer hands it on — what a fingerprint is taken of. */
const asFinding = (row) => ({
  checkKey: row.check_key, subjectType: row.subject_type, subjectId: row.subject_id, evidence: row.evidence_json,
});

function memoryRow(finding, over = {}) {
  return {
    id: 3,
    check_key: finding.check_key,
    subject_type: finding.subject_type,
    subject_id: finding.subject_id,
    answer_action: 'dismiss',
    answer_text: 'He swapped trucks.',
    evidence_fingerprint: fingerprintFor(asFinding(finding)),
    confirmed_by: 'telegram:1',
    expires_at: null,
    revoked_at: null,
    ...over,
  };
}

const SUGGEST = [{ check_key: 'identity.stale_unit_assignment', mode: 'suggest', shadow: false }];

function setWorld(over = {}) {
  world = {
    outstanding: 0, askedToday: 0, findings: [], memories: [], holds: [], checkSettings: SUGGEST, ...over,
  };
}

async function tick() {
  controlSettings.invalidateCache();
  sent.length = 0;
  const asked = [];
  const deps = {
    ...defaultDeps(),
    notify: async (n) => { asked.push(n.findingId); return { recorded: true }; },
    takeDecision: async () => ({ id: 1 }),
  };
  const result = await runAskPass({}, deps);
  const statements = [...sent];
  const listing = statements.map((s) => `  ${s.slice(0, 120)}`).join('\n');
  return { result, statements, asked, listing };
}

const reads = (statements, table) => statements.filter((s) => /^(SELECT|WITH)\b/i.test(s) && tableOf(s) === table);

test('OVER THE STANDING CAP: the settings, one count and one look for answered questions — nothing else', async () => {
  setWorld({
    outstanding: 5,
    findings: [findingRow({ id: 11 }), findingRow({ id: 12, subject_id: '50' }), findingRow({ id: 13, subject_id: '51' })],
    holds: [{ check_key: 'identity.stale_unit_assignment', subject_type: 'group', subject_id: '49', verdict: 'hold', reason: 'x' }],
  });
  const { result, statements, listing } = await tick();

  assert.equal(result.reason, 'waiting_for_answers');
  assert.equal(result.asked, 0);
  assert.ok(statements.length <= 3, `a capped tick sent ${statements.length} statements:\n${listing}`);
  assert.deepEqual(reads(statements, 'operational_decisions'), [], `the holds were read on a tick that cannot ask:\n${listing}`);
  assert.deepEqual(reads(statements, 'operational_check_settings'), [], `the check modes were read:\n${listing}`);
  assert.deepEqual(reads(statements, 'control_knowledge'), [], `memories were read with nothing remembered:\n${listing}`);
  const findingReads = reads(statements, 'operational_findings');
  assert.equal(findingReads.length, 1, listing);
  assert.match(findingReads[0], /control_knowledge/, 'it asks only for candidates somebody already answered');
});

test('PAST THE DAILY LIMIT: two counts, the settings and one look for answered questions', async () => {
  setWorld({
    askedToday: 2,
    findings: [findingRow({ id: 11 }), findingRow({ id: 12, subject_id: '50' })],
  });
  const { result, statements, listing } = await tick();

  assert.equal(result.reason, 'daily_limit');
  assert.equal(result.askedToday, 2);
  assert.ok(statements.length <= 4, `a tick past its daily limit sent ${statements.length} statements:\n${listing}`);
  assert.deepEqual(reads(statements, 'operational_decisions'), [], listing);
  assert.deepEqual(reads(statements, 'operational_check_settings'), [], listing);
  assert.deepEqual(reads(statements, 'control_knowledge'), [], listing);
});

test('A TICK THAT CANNOT ASK still closes what the owner already answered — reading only that', async () => {
  const answered = findingRow({ id: 11, check_key: 'board.truck_disagrees_with_profile', tier: 'approval',
    evidence_json: { personId: 5, profileUnit: '310', boardTruck: '311' } });
  setWorld({
    outstanding: 5,
    findings: [answered, findingRow({ id: 12, subject_id: '50' })],
    memories: [memoryRow(answered)],
  });
  const { result, statements, listing } = await tick();

  assert.equal(result.reason, 'waiting_for_answers');
  assert.equal(result.skipped.remembered, 1, 'the settled finding was closed');
  assert.ok(statements.some((s) => /^UPDATE operational_findings/.test(s)), listing);
  assert.equal(reads(statements, 'control_knowledge').length, 1, `one memory read:\n${listing}`);
  assert.deepEqual(reads(statements, 'operational_decisions'), [], listing);
  assert.deepEqual(reads(statements, 'operational_check_settings'), [], listing);
});

test('A FULL TICK reads no whole rows of findings, decisions or memories', async () => {
  const bonus = findingRow({
    id: 21, check_key: 'home_time.road_bonus_review', subject_type: 'road_history', subject_id: '7', tier: 'approval',
    evidence_json: { roadHistoryId: 7, daysOnRoad: 45, bonusUsd: 1200, driverName: 'TEST DRIVER' },
    proposed_change_json: { roadHistoryId: 7 },
  });
  const truck = findingRow({ id: 22 });
  setWorld({
    findings: [bonus, truck, findingRow({ id: 23, check_key: 'board.truck_disagrees_with_profile', subject_id: '52' })],
    // A memory about a DIFFERENT situation: it is read, it does not apply.
    memories: [memoryRow(truck, { evidence_fingerprint: 'a'.repeat(32) })],
    holds: [{ check_key: 'home_time.road_bonus_review', subject_type: 'road_history', subject_id: '7', verdict: 'hold', reason: 'confidence 60 below the floor of 70' }],
  });
  const { result, statements, asked, listing } = await tick();

  assert.deepEqual(asked, [21, 22], `the money question first, then the truck:\n${listing}`);
  assert.equal(result.asked, 2);
  const onAskPaths = statements.filter((s) => ASK_TABLES.includes(tableOf(s)));
  assert.ok(onAskPaths.length >= 3, `the candidates, the memories and the holds were all read:\n${listing}`);
  assert.deepEqual(onAskPaths.filter((s) => WHOLE_ROW.test(s)).map((s) => s.slice(0, 120)), [],
    `whole-row reads on the ask pass's paths:\n${listing}`);
});

test('THE MEMORY READ IS ONCE PER TICK, not once per finding', async () => {
  const findings = Array.from({ length: 5 }, (_, i) => findingRow({ id: 30 + i, subject_id: String(60 + i) }));
  setWorld({ findings, memories: [memoryRow(findings[3], { evidence_fingerprint: 'b'.repeat(32) })] });
  const { statements, listing } = await tick();

  assert.equal(reads(statements, 'control_knowledge').length, 1, `memory reads in one tick:\n${listing}`);
  assert.equal(reads(statements, 'operational_findings').length, 1, listing);
  assert.equal(reads(statements, 'operational_decisions').length, 1, listing);
});
