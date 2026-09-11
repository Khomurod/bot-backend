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
  assert.match(obs.detail, /2 of 2/);
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
  assert.equal(summary.checked, 1, 'only the notification queue had anything to say');
  assert.deepEqual(summary.errors, []);
});
