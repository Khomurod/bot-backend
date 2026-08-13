/**
 * The SOS assessment's six authoritative dispatch teams.
 *
 * These are the ONLY teams offered on /questions and /questions/test, the only
 * values a submission may carry, and the exact strings used everywhere
 * downstream. This suite pins:
 *
 *  - the six teams, their exact names, and their order;
 *  - that the list comes from code, not from the unrelated `dispatch_teams`
 *    table that Raise Approval / Driver Groups own (SOS must never read it, and
 *    must never write its foreign key);
 *  - that Dispatch REQUIRES a team and rejects anything not in the list;
 *  - that a submission stores the exact name, byte-for-byte;
 *  - that the team is questionnaire/admin vocabulary ONLY: no team result and no
 *    team name ever appears in the public /answers summary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const teams = require('../services/sosAssessment/dispatchTeams');
const { buildSummary } = require('../services/sosAssessment/aggregation');

const EXPECTED = [
  'Anthony / Allen / Scott',
  'Charles / Leo / Steven',
  'Smith / Colin / Kevin',
  'Franky / Sam / Ali',
  'Tony / Andy / Max',
  'Aaron / Jack',
];

test('there are exactly six teams, with the exact names, in order', () => {
  assert.equal(teams.SOS_DISPATCH_TEAMS.length, 6);
  assert.deepEqual(teams.SOS_DISPATCH_TEAMS.map((t) => t.name), EXPECTED);
  assert.deepEqual(teams.SOS_DISPATCH_TEAMS.map((t) => t.position), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    teams.SOS_DISPATCH_TEAMS.map((t) => t.key),
    ['team_1', 'team_2', 'team_3', 'team_4', 'team_5', 'team_6'],
  );
});

test('the public list sent to the questionnaire carries key + exact name only', () => {
  const publicTeams = teams.publicDispatchTeams();
  assert.deepEqual(publicTeams, EXPECTED.map((name, i) => ({ key: `team_${i + 1}`, name })));
  for (const team of publicTeams) assert.deepEqual(Object.keys(team).sort(), ['key', 'name']);
});

test('keys resolve to teams and unknown input resolves to null', () => {
  for (const [i, name] of EXPECTED.entries()) {
    assert.equal(teams.findDispatchTeamByKey(`team_${i + 1}`).name, name);
    assert.equal(teams.findDispatchTeamByName(name).key, `team_${i + 1}`);
  }
  for (const bad of ['team_0', 'team_7', '', '1', 'Team Alpha', null, undefined, 7, {}]) {
    assert.equal(teams.findDispatchTeamByKey(bad), null, `key ${JSON.stringify(bad)} must not resolve`);
  }
  assert.equal(teams.findDispatchTeamByName('Team Alpha'), null);
});

test('the team list is frozen, so no caller can mutate the vocabulary', () => {
  assert.throws(() => { teams.SOS_DISPATCH_TEAMS.push({ key: 'team_7', name: 'Nope' }); });
  // A property write on a frozen object fails silently outside strict mode, so
  // assert the EFFECT: the name is the identity used downstream and must hold.
  try { teams.SOS_DISPATCH_TEAMS[0].name = 'Renamed'; } catch (_) { /* strict mode throws */ }
  assert.equal(teams.SOS_DISPATCH_TEAMS[0].name, EXPECTED[0]);
  assert.deepEqual(teams.SOS_DISPATCH_TEAMS.map((t) => t.name), EXPECTED);
  // Mutating the public copy must not affect the source of truth either.
  const copy = teams.publicDispatchTeams();
  copy[0].name = 'Mutated';
  assert.deepEqual(teams.publicDispatchTeams()[0].name, EXPECTED[0]);
});

test('canonical ordering puts the six first and any legacy name after them', () => {
  assert.equal(teams.dispatchTeamOrder('Anthony / Allen / Scott'), 1);
  assert.equal(teams.dispatchTeamOrder('Aaron / Jack'), 6);
  assert.ok(teams.dispatchTeamOrder('Team Alpha') > 6);
  assert.ok(teams.dispatchTeamOrder(null) > 6);
});

test('the SOS service never reads the Raise Approval dispatch_teams table', () => {
  const source = require('fs').readFileSync(
    path.resolve(__dirname, '../services/sosAssessment/index.js'), 'utf8',
  );
  assert.ok(!/listDispatchTeams/.test(source),
    'SOS must not query the unrelated dispatch_teams table for its team list');
  assert.ok(!/raiseApproval/.test(source),
    'SOS must not depend on the Raise Approval module for teams');
});

// ─────────────── submit-time validation (service, stubbed database) ───────────────

const SERVICE_PATH = path.resolve(__dirname, '../services/sosAssessment/index.js');
const DB_PATH = path.resolve(__dirname, '../database/sosAssessment.js');

/** Loads the service with the database replaced by a recording stub. */
function loadService(created) {
  delete require.cache[SERVICE_PATH];
  delete require.cache[DB_PATH];
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: {
      getSettings: async () => ({ isOpen: true, testIsOpen: true, updatedAt: new Date() }),
      findDuplicate: async () => null,
      createSubmission: async (input) => {
        created.push(input);
        return { ...input, id: 1, createdAt: new Date('2026-07-31T00:00:00Z') };
      },
    },
  };
  const service = require(SERVICE_PATH);
  delete require.cache[SERVICE_PATH];
  delete require.cache[DB_PATH];
  return service;
}

/** A complete, valid 10-answer dispatch submission. */
function dispatchInput(overrides = {}) {
  const content = require('../services/sosAssessment/content');
  const questions = content.getQuestions('dispatch');
  return {
    fullName: 'Dispatcher One',
    department: 'dispatch',
    language: 'uz',
    contentVersion: content.CONTENT_VERSION,
    answers: questions.map((q) => ({ questionKey: q.key, optionKey: q.options[0].key })),
    isTest: true,
    ...overrides,
  };
}

test('getMeta offers exactly the six teams in both modes, with no database read', async () => {
  const service = loadService([]);
  for (const isTest of [false, true]) {
    const meta = await service.getMeta(isTest);
    assert.deepEqual(meta.dispatchTeams, EXPECTED.map((name, i) => ({ key: `team_${i + 1}`, name })));
  }
});

test('Dispatch requires a team: a missing key is a 400 and nothing is stored', async () => {
  for (const missing of [undefined, null, '']) {
    const created = [];
    const service = loadService(created);
    await assert.rejects(
      service.submitAssessment(dispatchInput({ dispatchTeamKey: missing })),
      (err) => err.code === 'TEAM_REQUIRED' && err.status === 400,
    );
    assert.deepEqual(created, []);
  }
});

test('an unknown or legacy team value is rejected, never silently accepted', async () => {
  for (const bad of ['team_7', '1', 3, 'Team Alpha', 'anthony']) {
    const created = [];
    const service = loadService(created);
    await assert.rejects(
      service.submitAssessment(dispatchInput({ dispatchTeamKey: bad })),
      (err) => err.code === 'UNKNOWN_TEAM' && err.status === 400,
      `${JSON.stringify(bad)} must be rejected`,
    );
    assert.deepEqual(created, []);
  }
});

test('each of the six teams submits and stores its exact name, with no FK id', async () => {
  for (const [i, name] of EXPECTED.entries()) {
    const created = [];
    const service = loadService(created);
    const result = await service.submitAssessment(dispatchInput({ dispatchTeamKey: `team_${i + 1}` }));
    assert.ok(result.resultToken);
    assert.equal(created.length, 1);
    assert.equal(created[0].dispatchTeamName, name);
    assert.equal(created[0].dispatchTeamId, null,
      'dispatch_team_id points at the unrelated dispatch_teams table and must stay NULL');
  }
});

test('a non-dispatch department stores no team even if a key is sent', async () => {
  const created = [];
  const service = loadService(created);
  const content = require('../services/sosAssessment/content');
  await service.submitAssessment({
    ...dispatchInput({ dispatchTeamKey: 'team_2' }),
    department: 'hr',
    answers: content.getQuestions('hr').map((q) => ({ questionKey: q.key, optionKey: q.options[0].key })),
  });
  assert.equal(created[0].dispatchTeamName, null);
  assert.equal(created[0].dispatchTeamId, null);
});

test('a pre-deployment client sending the old numeric id gets the RELOAD flow', async () => {
  // The old bundle sends dispatchTeamId, not dispatchTeamKey. Those ids belong to
  // the unrelated dispatch_teams rows, so they must never be translated into one
  // of the six — the employee is asked to reload and choose instead.
  for (const legacyId of [1, 3, 42, '5']) {
    const created = [];
    const service = loadService(created);
    await assert.rejects(
      service.submitAssessment(dispatchInput({ dispatchTeamId: legacyId })),
      (err) => err.code === 'STALE_CONTENT' && err.status === 409 && err.extra.staleContent === true,
      `legacy id ${JSON.stringify(legacyId)} must trigger the reload flow, not a team guess`,
    );
    assert.deepEqual(created, [], 'nothing may be stored from a stale payload');
  }
});

test('a fresh client is unaffected when both fields somehow arrive', async () => {
  const created = [];
  const service = loadService(created);
  await service.submitAssessment(dispatchInput({ dispatchTeamKey: 'team_2', dispatchTeamId: 99 }));
  assert.equal(created[0].dispatchTeamName, 'Charles / Leo / Steven',
    'the KEY wins; the legacy id is only ever a stale-client signal');
  assert.equal(created[0].dispatchTeamId, null);
});

test('a non-dispatch in-flight submission still succeeds after the change', async () => {
  const created = [];
  const service = loadService(created);
  const content = require('../services/sosAssessment/content');
  await service.submitAssessment({
    ...dispatchInput(),
    department: 'safety',
    answers: content.getQuestions('safety').map((q) => ({ questionKey: q.key, optionKey: q.options[0].key })),
  });
  assert.equal(created.length, 1, 'only the dispatch payload shape changed');
});

// ─────────────── teams stay OUT of the public summary ───────────────
// The team a person belongs to is questionnaire and admin vocabulary only. The
// public /answers pages show one company-wide picture, so no team result — and
// no team NAME — may appear in that payload, at any group size.

const submission = (department, primaryPattern, dispatchTeamName = null) => ({
  department, primaryPattern, dispatchTeamName, dispatchTeamId: null,
});

test('a dispatch respondent counts toward the company total, with no team breakdown', () => {
  const summary = buildSummary({
    open: true,
    submissions: [
      submission('dispatch', 'builder', 'Aaron / Jack'),
      submission('dispatch', 'ownership', 'Anthony / Allen / Scott'),
      submission('dispatch', 'waiting', 'Anthony / Allen / Scott'),
      submission('dispatch', 'blame', 'Tony / Andy / Max'),
      submission('hr', 'builder'),
    ],
  });
  assert.equal(summary.total, 5, 'every respondent counts exactly once, company-wide');
  const byPattern = Object.fromEntries(summary.company.primaryPatterns.map((r) => [r.pattern, r.count]));
  assert.deepEqual(byPattern, { victim: 0, complaint: 0, waiting: 1, blame: 1, ownership: 1, builder: 2 });
  assert.equal(summary.dispatchTeams, undefined, 'no dispatch-team section may exist');
  assert.equal(summary.departments, undefined, 'no department section may exist');
});

test('no team name reaches the public summary, even with all six represented', () => {
  const summary = buildSummary({
    open: true,
    submissions: [
      ...EXPECTED.map((name) => submission('dispatch', 'builder', name)),
      submission('dispatch', 'ownership', 'Team Alpha'), // a legacy stored name
    ],
  });
  const serialized = JSON.stringify(summary);
  for (const name of [...EXPECTED, 'Team Alpha']) {
    assert.ok(!serialized.includes(name), `${name} must never be published`);
  }
  assert.ok(!/teamName|dispatchTeam|team_[1-6]/.test(serialized), 'no team field of any kind');
  assert.ok(!/fullName|resultToken|clientIp/.test(serialized));
  assert.equal(summary.total, 7);
});
