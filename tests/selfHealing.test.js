'use strict';

/**
 * Noticing when a part of Wenze breaks, and when it puts itself right.
 *
 * The property this file exists to hold is SILENCE. Wenze already recovers from
 * most of its own integration failures and always has; a naive "announce every
 * recovery" would turn that into a stream nobody reads, at which point the one
 * outage that needed a person is in it and invisible.
 *
 * And the second: this adds NO RECOVERY. Nothing here retries, reconnects, or
 * probes an external service — a health check that makes its own requests is a
 * new way to be rate limited. It reads what the application already recorded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const healing = require('../services/operations/selfHealing');

const NOW = Date.parse('2026-09-11T12:00:00Z');

function harness({ observations = [], previous = {} } = {}) {
  const calls = { notified: [], saved: [] };
  const states = { ...previous };
  const deps = {
    store: {
      async getHealthState(component) { return states[component] || null; },
      async saveHealthState(state) { states[state.component] = state; calls.saved.push(state); return state; },
    },
    async notify(n) { calls.notified.push(n); return { recorded: true, delivered: true }; },
    rc: {}, ai: {}, notifications: {},
  };
  // The gatherer is replaced wholesale: WHAT is observed is a separate concern
  // from WHEN an observation is worth mentioning, and only the second is the
  // interesting one.
  const original = healing.gatherObservations;
  deps.__restore = () => { healing.gatherObservations = original; };
  return { deps, calls, states, observations };
}

/** Run a sequence of observations for one component through the real rules. */
async function sequence(results, { deps, calls, states }) {
  for (let i = 0; i < results.length; i += 1) {
    const [ok, detail] = results[i];
    // eslint-disable-next-line no-await-in-loop
    await healing.considerComponent(
      { component: 'ai_providers', ok, detail },
      {
        nowIso: new Date(NOW + i * 30 * 60000).toISOString(),
        deps,
        options: { failuresBeforeAlert: 3, flapWindowHours: 6, flapThreshold: 4 },
      },
    );
  }
  return calls.notified;
}

test('a healthy component is recorded and nobody is told', async () => {
  const h = harness();
  const notices = await sequence([[true], [true], [true]], h);
  assert.deepEqual(notices, []);
  assert.equal(h.states.ai_providers.status, 'ok');
});

test('A BLIP THAT SELF-CORRECTS PRODUCES ZERO MESSAGES, NOT ONE', async () => {
  const h = harness();
  const notices = await sequence([[true], [false, '503'], [false], [true]], h);
  assert.deepEqual(notices, [], 'nobody was told it broke, so nobody is told it healed');
});

test('a real outage is announced once, and to the channel that needs a person', async () => {
  const h = harness();
  const notices = await sequence([[true], [false, 'all 3 providers are in cooldown'], [false], [false], [false], [false]], h);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].category, 'system_errors');
  assert.match(notices[0].title, /not working/);
  assert.match(notices[0].action, /Needs a person/);
});

test('recovery goes to the SELF-HEALING channel and says nothing is needed', async () => {
  const h = harness();
  const notices = await sequence([[true], [false, 'cooldown'], [false], [false], [true]], h);
  assert.deepEqual(notices.map((n) => n.category), ['system_errors', 'self_healing']);
  assert.match(notices[1].title, /working again/);
  assert.match(notices[1].reason, /Nothing is needed/);
});

test('the recovery notice says how long it was down', async () => {
  const h = harness();
  const notices = await sequence([[true], [false, 'cooldown'], [false], [false], [true]], h);
  assert.match(notices[1].title, /after \d+ (minutes|hours)/);
});

test('a component that cannot stay up is ONE problem, not a commentary', async () => {
  const h = harness();
  const notices = await sequence([
    [true],
    [false], [false], [false], [true],
    [false], [false], [false], [true],
    [false], [false], [false], [true],
    [false], [false], [false],
  ], h);
  const flapping = notices.filter((n) => /repeatedly/.test(n.title));
  assert.equal(flapping.length, 1, 'said once');
  assert.equal(flapping[0].category, 'system_errors');
  assert.match(flapping[0].action, /recovering each time/);
  // And after it, nothing more while it lasts.
  const afterIndex = notices.indexOf(flapping[0]);
  assert.deepEqual(notices.slice(afterIndex + 1), []);
});

test('each notice carries the component so a destination can be split per system', async () => {
  const h = harness();
  const notices = await sequence([[true], [false, 'x'], [false], [false]], h);
  assert.equal(notices[0].subjectType, 'system');
  assert.equal(notices[0].subjectId, 'ai_providers');
  assert.equal(notices[0].evidence.component, 'ai_providers');
});

test('components are named in words an operator recognises', () => {
  for (const [key, label] of Object.entries(healing.LABELS)) {
    assert.ok(label.length > key.length / 2, key);
    assert.ok(!label.includes('_'), `${key} must not be shown as a key`);
  }
});

// ── what is observed ────────────────────────────────────────────────────────

test('NOTHING PROBES AN EXTERNAL SERVICE — every observation is a read', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../services/operations/selfHealing'), 'utf8'
  );
  for (const forbidden of ['fetch(', 'axios', 'http.get', 'https.get']) {
    assert.ok(!src.includes(forbidden), `a health check must not call ${forbidden}`);
  }
});

test('a source that cannot be read is UNKNOWN, never failed', async () => {
  const deps = {
    rc: { async listRecruiters() { throw new Error('database down'); }, recruiterCanSendSms: () => true },
    ai: { async getProvidersForRouter() { throw new Error('database down'); } },
    notifications: { async summariseNotifications() { throw new Error('database down'); } },
  };
  const out = await healing.gatherObservations(deps);
  assert.deepEqual(out, [], '"I could not check" is not "it is broken"');
});

test('all recruiter logins broken is an outage; one is a person\'s problem', async () => {
  const make = (broken) => ({
    rc: {
      async listRecruiters() {
        return [
          { id: 1, refresh_token_encrypted: 'x', rc_auth_error: broken > 0 ? 'expired' : null },
          { id: 2, refresh_token_encrypted: 'x', rc_auth_error: broken > 1 ? 'expired' : null },
        ];
      },
      recruiterCanSendSms: () => true,
    },
    ai: { async getProvidersForRouter() { return []; } },
    notifications: { async summariseNotifications() { return { abandoned: 0 }; } },
  });

  const one = await healing.gatherObservations(make(1));
  assert.equal(one.find((o) => o.component === 'recruiter_logins').ok, true, 'one broken is not an outage');

  const all = await healing.gatherObservations(make(2));
  const obs = all.find((o) => o.component === 'recruiter_logins');
  assert.equal(obs.ok, false);
  assert.match(obs.detail, /all 2 recruiter logins/);
});

test('every enabled AI provider in cooldown at once is an outage; one is the router working', async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  const make = (cooled) => ({
    rc: { async listRecruiters() { return []; }, recruiterCanSendSms: () => false },
    ai: {
      async getProvidersForRouter() {
        return [
          { providerKey: 'groq', enabled: true, cooledUntil: cooled > 0 ? future : null },
          { providerKey: 'gemini', enabled: true, cooledUntil: cooled > 1 ? future : null },
        ];
      },
    },
    notifications: { async summariseNotifications() { return { abandoned: 0 }; } },
  });

  assert.equal((await healing.gatherObservations(make(1))).find((o) => o.component === 'ai_providers').ok, true);
  const all = (await healing.gatherObservations(make(2))).find((o) => o.component === 'ai_providers');
  assert.equal(all.ok, false);
  assert.match(all.detail, /all 2 providers/);
});

test('a notice queue that gave up is a failure — it is what silences every other alarm', async () => {
  const deps = {
    rc: { async listRecruiters() { return []; }, recruiterCanSendSms: () => false },
    ai: { async getProvidersForRouter() { return []; } },
    notifications: { async summariseNotifications() { return { abandoned: 12 }; } },
  };
  const obs = (await healing.gatherObservations(deps)).find((o) => o.component === 'notifications');
  assert.equal(obs.ok, false);
  assert.match(obs.detail, /12 notices gave up/);
});

test('a pass with nothing observable reports cleanly rather than throwing', async () => {
  const deps = {
    ...harness().deps,
    rc: { async listRecruiters() { return []; }, recruiterCanSendSms: () => false },
    ai: { async getProvidersForRouter() { return []; } },
    notifications: { async summariseNotifications() { return { abandoned: 0 }; } },
  };
  const summary = await healing.runSelfHealingPass({ now: NOW, deps });
  assert.ok(summary.checked > 0);
  assert.deepEqual(summary.errors, []);
});

test('a feature nobody has configured says so, instead of vanishing', async () => {
  const deps = {
    ...harness().deps,
    rc: { async listRecruiters() { return []; }, recruiterCanSendSms: () => false },
    ai: { async getProvidersForRouter() { return []; } },
    notifications: { async summariseNotifications() { return { abandoned: 0 }; } },
  };
  const obs = await healing.gatherObservations(deps);

  const rc = obs.find((o) => o.component === 'recruiter_logins');
  assert.equal(rc.state, 'needs_human_attention');
  assert.equal(rc.ok, true,
    'not a FAILURE — painting an unconfigured feature red is how a real outage '
    + 'gets lost among things nobody ever switched on');
  assert.match(rc.reason, /RingCentral login/);

  const ai = obs.find((o) => o.component === 'ai_providers');
  assert.equal(ai.state, 'needs_human_attention');
  assert.match(ai.reason, /deterministic fallback/,
    'and it says what the consequence is, not only that something is missing');
});

test('a component nobody could read is dropped before it can start a failure count', async () => {
  const deps = {
    ...harness().deps,
    runs: { async getRunMap() { throw new Error('no such table'); }, async getRun() { throw new Error('no'); } },
    rc: { async listRecruiters() { throw new Error('no such table'); }, recruiterCanSendSms: () => false },
    ai: { async getProvidersForRouter() { throw new Error('no such table'); } },
    notifications: { async summariseNotifications() { throw new Error('no such table'); } },
    fuelReadings: { async summariseFuelReadings() { throw new Error('no such table'); } },
  };
  const obs = await healing.gatherObservations(deps);
  assert.deepEqual(obs, [],
    '"I could not check" is not "it is broken" — three unreadable passes would '
    + 'otherwise announce an outage that was only ever a failing health query');
});

// ── the watchman that could not report itself ───────────────────────────────

/**
 * A PASS THAT OBSERVED NOTHING IS A FAILED PASS, NOT A CLEAN ONE.
 *
 * This is the same defect the contradiction pass had, in the one place it
 * matters most. `runSelfHealingPass` returns `errors` — plural, a list —
 * and `statusFromSummary` reads `error`, singular, and knows nothing about it.
 * So when `gatherObservations` throws, the pass returns early having saved
 * NOTHING, and the ledger records `status: 'ok'`.
 *
 * The consequence is the worst-shaped failure in the application. This is the
 * watch that makes every OTHER component's failure visible; when it dies,
 * `system_health_states` simply freezes at whatever it last held, every
 * component keeps reporting the health it had at that moment, and
 * `self_healing` — catalogued CRITICAL — reads healthy the whole time. Nothing
 * anywhere says the health picture stopped moving.
 *
 * Found in production: after 041aa8b deployed, the components it newly marked
 * `blocked` never moved into `systems.waiting` across 32 minutes and at least
 * one due pass, while `self_healing` read healthy throughout.
 *
 * The rule is the one already settled for the contradiction pass: the PASS
 * decides whether its errors amount to a failure and says so in `error`;
 * `statusFromSummary` stays deliberately dumb, so "one bad component among
 * many is not a failed pass" keeps holding.
 */
test('A PASS THAT OBSERVED NOTHING IS A FAILED PASS, NOT A CLEAN ONE', async () => {
  // eslint-disable-next-line global-require
  const { statusFromSummary } = require('../services/operations/runLedger');
  const { deps } = harness();
  deps.store.getHealthState = async () => null;
  deps.gather = async () => { throw new Error('relation does not exist'); };

  const summary = await healing.runSelfHealingPass({ now: NOW, deps });

  assert.equal(summary.checked, 0, 'it recorded nothing');
  assert.equal(statusFromSummary(summary).status, 'error',
    'the watch that watches everything else must be loud when it cannot run');
  assert.match(summary.error, /could not read the health of any component/);
});

test('and a pass where EVERY component failed to record is a failed pass too', async () => {
  // eslint-disable-next-line global-require
  const { statusFromSummary } = require('../services/operations/runLedger');
  const { deps } = harness();
  deps.store.saveHealthState = async () => { throw new Error('read-only transaction'); };
  deps.gather = async () => ([{ component: 'a', ok: true }, { component: 'b', ok: true }]);

  const summary = await healing.runSelfHealingPass({ now: NOW, deps });

  assert.equal(summary.errors.length, 2);
  assert.equal(statusFromSummary(summary).status, 'error');
  assert.match(summary.error, /none of the 2 component\(s\)/);
});

/** But one unreadable component among many is noise, not an outage. */
test('one component failing among several is still a pass that did its job', async () => {
  // eslint-disable-next-line global-require
  const { statusFromSummary } = require('../services/operations/runLedger');
  const { deps } = harness();
  let n = 0;
  const realSave = deps.store.saveHealthState;
  deps.store.saveHealthState = async (state) => {
    n += 1;
    if (n === 1) throw new Error('deadlock detected');
    return realSave(state);
  };
  deps.gather = async () => ([{ component: 'a', ok: true }, { component: 'b', ok: true }]);

  const summary = await healing.runSelfHealingPass({ now: NOW, deps });

  assert.equal(summary.errors.length, 1);
  assert.equal(statusFromSummary(summary).status, 'ok',
    'it recorded the component it could');
});

// ── the components the watch could not see ─────────────────────────────────

/**
 * THE WATCH SUPPLIED SEVEN OF THE ELEVEN DEPENDENCIES ITS OWN OBSERVATIONS NEED.
 *
 * `gatherAllObservations(deps)` uses what it is handed, verbatim — it does not
 * merge in its own defaults. `selfHealing.defaultDeps()` grew separately from
 * `healthObservations.defaultDeps()` and drifted six keys behind it.
 *
 * The result is not a crash. Each affected check throws, its own `catch` turns
 * that into `{ state: UNKNOWN, reason: 'could not read' }`, and
 * `gatherObservations` then DELIBERATELY drops unknowns — "I could not check"
 * must never start a failure count, which is the right rule. So the components
 * simply vanished: never written to `system_health_states`, never announced,
 * never counted in `systems`. Permanently, and completely silently.
 *
 * Confirmed against production: the health summary observes 40 components and
 * the watch persists 37. The three it could not see include
 * `notification_destination` — the thing that DELIVERS every operational
 * notice. Had that broken, the watch whose job is to announce it would have
 * dropped it as unreadable and said nothing at all.
 *
 * This test is the drift guard. The composition below makes it pass today; this
 * makes it stay true when either list grows again.
 */
test('THE WATCH SUPPLIES EVERY DEPENDENCY ITS OWN OBSERVATIONS NEED', () => {
  // eslint-disable-next-line global-require
  const observations = require('../services/operations/healthObservations');
  const needed = Object.keys(observations.defaultDeps());
  const supplied = Object.keys(healing.defaultDeps());

  const missing = needed.filter((k) => !supplied.includes(k));
  assert.deepEqual(missing, [],
    'a dependency the watch does not supply makes its component vanish, not fail');
});

/**
 * And when one DOES come back unreadable, the pass says how many it dropped.
 *
 * Dropping is correct — see above — but dropping silently is what let six
 * missing dependencies hide for the life of the feature. A count is the
 * cheapest thing that would have shown it.
 */
test('a pass counts the components it had to drop, instead of dropping them silently', async () => {
  const { deps } = harness();
  deps.gather = async () => ([
    { component: 'a', ok: true },
    { component: 'b', ok: true, unknown: true },
    { component: 'c', ok: true, unknown: true },
  ]);

  const summary = await healing.runSelfHealingPass({ now: NOW, deps });

  assert.equal(summary.checked, 1, 'only the readable one was recorded');
  assert.equal(summary.unreadable, 2, 'and it says so rather than quietly shrinking');
});
