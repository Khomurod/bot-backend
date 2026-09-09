/**
 * WHAT AN AI MODEL IS ALLOWED TO DECIDE ABOUT A DRIVER'S EMPLOYMENT.
 *
 * `status_source = 'ai'` is on 168 of 209 production groups. The model reads a
 * Telegram chat TITLE and the result is written to `driver_profiles.status` —
 * so a model reading `WENZE UNIT # 310 J. DOE` can mark a working driver
 * terminated. And it was pushed towards exactly that: the system prompt says
 * *"If unsure, set active to false"*, and `row.active === true` collapsed
 * "false", "unsure" and "the model omitted the field" into one answer.
 *
 * The rule this pins is the one the whole project rests on: **ambiguity means
 * NO CHANGE.** A model may say "inactive", it may say "active", and it may say
 * "I cannot tell from a chat title" — and the third is not a synonym for the
 * first. Nothing in a job status should ever be decided by a default.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseClassificationResponse, classifyGroupHeuristic, buildClassificationPrompt,
} = require('../services/groupStatusAiClassifier');

const batch = [
  { id: 1, group_name: 'WENZE UNIT # 310 JOHN DOE' },
  { id: 2, group_name: 'WENZE UNIT # 311 JANE ROE INACTIVE' },
  { id: 3, group_name: 'WENZE UNIT # 312' },
];

test('the model may say it cannot tell, and that is not "inactive"', () => {
  const results = parseClassificationResponse(JSON.stringify([
    { id: 1, active: true, reason: 'no marker' },
    { id: 2, active: false, reason: 'INACTIVE in the title' },
    { id: 3, active: 'unknown', reason: 'no driver name at all' },
  ]), batch);

  const byId = new Map(results.map((r) => [r.id, r]));
  assert.equal(byId.get(1).active, true);
  assert.equal(byId.get(2).active, false);
  assert.equal(byId.get(3).active, null,
    'null is "I cannot tell" — a third answer, not a soft false');
});

test('an omitted or unparseable `active` is also "cannot tell"', () => {
  for (const value of [undefined, null, 'yes', 1, {}]) {
    const [row] = parseClassificationResponse(
      JSON.stringify([{ id: 1, active: value, reason: 'x' }]), [batch[0]]
    );
    assert.equal(row.active, null, `active: ${JSON.stringify(value)}`);
  }
});

test('the prompt no longer instructs the model to guess "inactive"', () => {
  const prompt = buildClassificationPrompt(batch);
  assert.doesNotMatch(prompt, /When ambiguous, active=false/i,
    'telling a model to resolve doubt against the driver is how 168 groups got an AI-set status');
  assert.match(prompt, /unknown/i, 'and it must be told what to say instead');
});

test('the heuristic asserts INACTIVE from evidence, and never ACTIVE from its absence', () => {
  // "The title does not say INACTIVE" is not evidence that somebody still works
  // here. It is the absence of evidence, and reactivating a driver on it is the
  // same overwrite facing the other way.
  assert.equal(classifyGroupHeuristic({ id: 2, group_name: 'JANE ROE INACTIVE' }).active, false);
  assert.equal(classifyGroupHeuristic({ id: 2, group_name: 'JANE ROE TERMINATED' }).active, false);
  assert.equal(classifyGroupHeuristic({ id: 1, group_name: 'JOHN DOE' }).active, null,
    'no marker means nothing is known, not that the driver is active');
});

// ─── the two writers ─────────────────────────────────────────────────────────
//
// `driver_profiles.status` and `groups.active` are written by two different
// services from the same classification, and BOTH coerced. `!!null` is false and
// `active === false ? 'inactive' : 'active'` makes null mean active — so an
// "I cannot tell" would have marked one driver terminated and reactivated
// another, from the same answer, in the same run.

const path = require('node:path');

function loadStatusService({ groups, classifications }) {
  const SERVICE = path.resolve(__dirname, '../services/groupStatusAiService.js');
  const DB = path.resolve(__dirname, '../database/db.js');
  const CLASSIFIER = path.resolve(__dirname, '../services/groupStatusAiClassifier.js');
  for (const p of [SERVICE]) delete require.cache[p];

  const writes = [];
  require.cache[DB] = {
    exports: {
      async getDriverGroupsForStatusAi() { return groups; },
      async updateGroupOperationalStatus(id, active, source) { writes.push({ id, active, source }); },
      async claimServiceRun() { return true; },
    },
  };
  const real = require(CLASSIFIER);
  require.cache[CLASSIFIER] = {
    exports: { ...real, async classifyDriverGroups() { return new Map(classifications); } },
  };
  return { service: require(SERVICE), writes };
}

test('an unresolved classification writes NOTHING to groups.active', async () => {
  const { service, writes } = loadStatusService({
    groups: [
      { id: 1, group_name: 'A', active: true, status_source: 'ai' },
      { id: 2, group_name: 'B', active: true, status_source: 'ai' },
    ],
    classifications: [
      [1, { active: null, reason: 'cannot tell from the title' }],
      [2, { active: false, reason: 'INACTIVE' }],
    ],
  });

  const result = await service.runClassificationRun();

  assert.deepEqual(writes, [{ id: 2, active: false, source: 'ai' }],
    'only the group the model actually had an answer about');
  assert.equal(result.unresolved, 1, 'and the ones it could not answer are counted, not silent');
});

test('an unresolved classification leaves driver_profiles.status alone', async () => {
  // The other writer, from the same classification map. `active === false ?
  // 'inactive' : 'active'` made null mean ACTIVE — so one ambiguous answer
  // terminated a driver through `groups.active` and reactivated another through
  // `driver_profiles.status`, in the same run.
  const SYNC = path.resolve(__dirname, '../services/driverGroupAiSyncService.js');
  const DB = path.resolve(__dirname, '../database/db.js');
  const CLASSIFIER = path.resolve(__dirname, '../services/groupStatusAiClassifier.js');
  const PARSER = path.resolve(__dirname, '../services/driverProfileAiParser.js');
  delete require.cache[SYNC];

  const patches = [];
  require.cache[DB] = {
    exports: {
      async listDriverProfiles() {
        return [
          {
            id: 11, group_id: 1, group_name: 'A', group_active: false,
            status: 'inactive', status_source: 'bot', first_name: 'Jo', unit_number: '1',
          },
          {
            id: 12, group_id: 2, group_name: 'B', group_active: true,
            status: 'active', status_source: 'ai', first_name: 'Al', unit_number: '2',
          },
        ];
      },
      async updateDriverProfile(id, patch) { patches.push({ id, patch }); return {}; },
      async updateGroupOperationalStatus() {},
    },
  };
  require.cache[PARSER] = { exports: { async parseGroups() { return []; } } };
  const realClassifier = require(CLASSIFIER);
  require.cache[CLASSIFIER] = {
    exports: {
      ...realClassifier,
      async classifyDriverGroups() {
        return new Map([
          [1, { active: null, reason: 'cannot tell' }],
          [2, { active: null, reason: 'cannot tell' }],
        ]);
      },
    },
  };

  const sync = require(SYNC);
  const result = await sync.runUnifiedDriverGroupAiSync({ apply: true });

  for (const { patch } of patches) {
    assert.equal('status' in patch, false, 'no status may be written from an unresolved answer');
  }
  const byId = new Map(result.proposals.map((p) => [p.group_id, p]));
  assert.equal(byId.get(1).proposed.status, 'inactive', 'an inactive driver is NOT reactivated');
  assert.equal(byId.get(2).proposed.status, 'active', 'and an active one is not terminated');
  assert.equal(byId.get(1).status_source, 'ai_unresolved');
});
