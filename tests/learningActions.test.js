/**
 * The boundary on what accepting a suggestion may change.
 *
 * WHY A TEST AND NOT A COMMENT. Accepting used to do nothing, and the route's
 * comment called that the safety property. It was half of one: the guarantee
 * worth keeping is that AI cannot change a business rule BY ITSELF, and that is
 * kept by requiring an administrator's confirmation — not by making the
 * confirmation inert. But once acceptance CAN change something, "what may it
 * change" stops being rhetoric and becomes an invariant, and an invariant a
 * future contributor can violate by adding one object literal needs a test in
 * front of it.
 *
 * So this asserts the registry's exact contents, and that the one action in it
 * can only ever turn automation OFF.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const actions = require('../services/operations/learningActions');

/**
 * THE REGISTRY IS WRITTEN OUT, so adding to it fails here and has to be argued.
 *
 * It held exactly one action for most of its life. The second exists because an
 * administrator could be shown a concrete threshold and agree to it, and nothing
 * happened — the same defect the first action was added to fix, one level up.
 * Both can only ever make Wenze MORE cautious; see the test below.
 */
test('the registry holds exactly the actions that have been argued for', () => {
  assert.deepEqual(actions.listLearningActions().sort(),
    ['disable_auto_apply', 'raise_confidence_floor']);
});

test('there is no action that turns automation ON', () => {
  for (const key of actions.listLearningActions()) {
    assert.ok(!/enable|grant|allow|turn_on/.test(key),
      `${key} — a machine proposing that it be trusted with MORE is the one shape `
      + 'nobody should build, however many confirmations sit in front of it');
  }
});

/** The file with its comments removed — the prose names what it refuses to do. */
function codeOnly(modulePath) {
  return fs.readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

test('nothing in the registry can touch pay, employment, hiring or discipline', () => {
  const src = codeOnly('../services/operations/learningActions');
  // The words a change to any of those would have to reach for. Deliberately
  // crude: a future action that genuinely needs one of these tables has to
  // delete an assertion to get there, which is the point.
  // `raise` was a bare token here and caught the pay-raise feature by name.
  // `raise_confidence_floor` collides with it and is the opposite of a pay
  // change, so the token is narrowed to the identifiers the raise feature
  // actually uses — every table and module name in the codebase — rather than
  // dropped. Narrowing a safety assertion is only acceptable when the new form
  // still catches everything the old one was aimed at, and these do.
  for (const forbidden of [
    'driver_profiles', 'mileage_bonus', 'bonus_usd', 'employment', 'status_source',
    'raise_otp', 'raise_round', 'raise_settings', 'raiseApproval', 'raiseResults', 'driver_raises',
    'terminate', 'driver_safety_coaching', 'recruiting_knowledge', 'ai_capabilities',
    'writeFile', 'exec(', 'spawn(',
  ]) {
    assert.ok(!src.includes(forbidden),
      `the learning registry must never reach for "${forbidden}"`);
  }
});

test('every action changes only operational_check_settings', () => {
  const src = codeOnly('../services/operations/learningActions');
  const calls = [...src.matchAll(/deps\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)]
    .map((m) => `${m[1]}.${m[2]}`);
  // Every one of these is a column on `operational_check_settings`, whose whole
  // purpose is to be toggled and whose previous value is recorded before it
  // changes. A call to anything else is the registry growing a reach it has not
  // been argued into.
  assert.deepEqual([...new Set(calls)].sort(), [
    'checkSettings.deleteCheckSettings',
    'checkSettings.listCheckSettings',
    'checkSettings.setMinConfidence',
    'checkSettings.upsertCheckSettings',
  ]);
});

// ── what applying and reverting actually do ─────────────────────────────────

function settingsStub(rows = []) {
  const state = new Map(rows.map((r) => [r.checkKey, { ...r }]));
  return {
    calls: [],
    async listCheckSettings() { return [...state.values()]; },
    async upsertCheckSettings(key, args) {
      this.calls.push({ op: 'upsert', key, ...args });
      state.set(key, { checkKey: key, ...args });
    },
    async deleteCheckSettings(key) {
      this.calls.push({ op: 'delete', key });
      state.delete(key);
    },
    state,
  };
}

const action = () => actions.getLearningAction('disable_auto_apply');

test('applying switches the check off and records what it was', async () => {
  const checkSettings = settingsStub([
    { checkKey: 'home_time.closable_open_cycle', autoApplyEnabled: true, maxAutoPerRun: 80 },
  ]);
  const out = await action().apply(
    { checkKeys: ['home_time.closable_open_cycle'] }, { checkSettings, actor: 'boss' }
  );

  assert.equal(out.changed, 1);
  assert.deepEqual(out.before['home_time.closable_open_cycle'],
    { present: true, autoApplyEnabled: true, maxAutoPerRun: 80 });
  assert.equal(checkSettings.calls[0].autoApplyEnabled, false);
  assert.equal(checkSettings.calls[0].maxAutoPerRun, 80, 'the cap it had is not quietly reset');
});

test('a check that was never configured is recorded as ABSENT, not as false', async () => {
  const checkSettings = settingsStub([]);
  const out = await action().apply({ checkKeys: ['load.phase_unclear'] }, { checkSettings });
  assert.deepEqual(out.before['load.phase_unclear'], { present: false },
    'no row and a row saying FALSE are different things, and only one of them '
    + 'is a decision somebody took');
});

test('reverting restores what was THERE, not a default', async () => {
  const checkSettings = settingsStub([]);
  await action().revert({
    'a.check': { present: true, autoApplyEnabled: true, maxAutoPerRun: 120 },
    'b.check': { present: false },
  }, { checkSettings });

  const upsert = checkSettings.calls.find((c) => c.op === 'upsert');
  assert.equal(upsert.key, 'a.check');
  assert.equal(upsert.autoApplyEnabled, true);
  assert.equal(upsert.maxAutoPerRun, 120);

  const del = checkSettings.calls.find((c) => c.op === 'delete');
  assert.equal(del.key, 'b.check', 'the absence is put back, not a FALSE somebody '
    + 'could later read as a decision');
});

test('a check already switched off is left alone rather than rewritten', async () => {
  const checkSettings = settingsStub([
    { checkKey: 'x', autoApplyEnabled: false, maxAutoPerRun: 50 },
  ]);
  const out = await action().apply({ checkKeys: ['x'] }, { checkSettings });
  assert.equal(out.changed, 0);
  assert.deepEqual(checkSettings.calls, []);
});

test('an empty payload is refused rather than silently doing nothing', async () => {
  await assert.rejects(() => action().apply({ checkKeys: [] }, { checkSettings: settingsStub() }),
    /names no check/);
});

test('the description says what will happen, in words an operator can check', () => {
  assert.match(action().describe({ checkKeys: ['home_time.closable_open_cycle'] }),
    /switched off for home_time\.closable_open_cycle/);
  assert.match(action().describe({ checkKeys: ['a', 'b'] }), /2 checks/);
  assert.match(action().describe({ checkKeys: ['a'] }), /propose instead of repairing/);
});
