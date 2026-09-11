/**
 * Every worker and integration, observed from what the application already
 * wrote down.
 *
 * WHAT THIS REPLACED: three hand-written components — recruiter logins, AI
 * providers and the notification queue — while twenty-five background workers
 * and nine integrations ran beside them completely unobserved.
 *
 * The assertions that matter are the refusals. A component nobody could read
 * must not be reported as healthy AND must not be reported as failed; a feature
 * nobody configured must not enter a failure count; and a worker that stopped
 * must be distinguishable from one that ran and found nothing, which is the
 * single ambiguity this whole mechanism exists to remove.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const obs = require('../services/operations/healthObservations');
const { CATALOG } = require('../lib/operations/backgroundServiceCatalog');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

const run = (over = {}) => ({
  lastFinishedAt: minutesAgo(5), lastStartedAt: minutesAgo(5), lastStatus: 'ok',
  consecutiveFailures: 0, runsTotal: 10, failuresTotal: 0, ...over,
});

function deps({ runMap = new Map(), recruiters = [], providers = [], notifications = {}, fuel = null } = {}) {
  return {
    runs: {
      async getRunMap() { return runMap; },
      async getRun(key) { return runMap.get(key) || null; },
    },
    rc: {
      async listRecruiters() { return recruiters; },
      recruiterCanSendSms: (r) => Boolean(r.canSend),
    },
    ai: { async getProvidersForRouter() { return providers; } },
    notifications: { async summariseNotifications() { return notifications; } },
    fuelReadings: { async summariseFuelReadings() { return fuel; } },
  };
}

const find = (list, key) => list.find((o) => o.component === key);

test('every catalogued worker is observed, not only the three that used to be', async () => {
  const all = await obs.gatherAllObservations(deps({}), { now: NOW });
  const workers = CATALOG.filter((e) => e.group !== 'integration');
  for (const entry of workers) {
    assert.ok(find(all, entry.key), `${entry.key} must be observed`);
  }
  assert.ok(all.length >= 25, `expected the whole roster, got ${all.length}`);
});

test('a worker nobody has ever heard from is "cannot determine", not healthy', async () => {
  const all = await obs.gatherAllObservations(deps({}), { now: NOW });
  const fuel = find(all, 'fuel_risk');
  assert.equal(fuel.state, 'cannot_determine');
  assert.equal(fuel.unknown, true,
    'and it is marked so the announcer drops it — "I could not check" must '
    + 'never start a failure count');
});

test('a worker that stopped is separated from one that found nothing', async () => {
  const runMap = new Map([
    ['fuel_risk', run()],
    ['load_lifecycle', run({ lastFinishedAt: minutesAgo(400) })],
  ]);
  const all = await obs.gatherAllObservations(deps({ runMap }), { now: NOW });

  assert.equal(find(all, 'fuel_risk').state, 'healthy');
  assert.equal(find(all, 'fuel_risk').ok, true);

  const stopped = find(all, 'load_lifecycle');
  assert.equal(stopped.state, 'stale_stopped');
  assert.equal(stopped.ok, false, 'and this one is actionable');
  assert.match(stopped.detail, /no pass has finished/);
});

test('one failed pass is degraded and does NOT raise anything', async () => {
  const runMap = new Map([['safety_coach', run({ lastStatus: 'error', consecutiveFailures: 1, failuresTotal: 1 })]]);
  const all = await obs.gatherAllObservations(deps({ runMap }), { now: NOW });
  const coach = find(all, 'safety_coach');
  assert.equal(coach.state, 'degraded');
  assert.equal(coach.ok, true, 'integrations blip; announcing this is how a channel becomes unread');
});

// ── the integrations ─────────────────────────────────────────────────────────

test('a stale ELD feed is one answer, not four features going quiet separately', async () => {
  const fresh = await obs.gatherAllObservations(
    deps({ fuel: { trucks: 110, withFuel: 100, comparable: 40, newestReading: minutesAgo(25) } }),
    { now: NOW }
  );
  assert.equal(find(fresh, 'eld_location_freshness').ok, true);

  const stale = await obs.gatherAllObservations(
    deps({ fuel: { trucks: 110, withFuel: 100, comparable: 40, newestReading: minutesAgo(60 * 9) } }),
    { now: NOW }
  );
  const eld = find(stale, 'eld_location_freshness');
  assert.equal(eld.ok, false);
  assert.match(eld.detail, /9 hours old/);
});

test('no position recorded yet is unknown, not a stale feed', async () => {
  const all = await obs.gatherAllObservations(
    deps({ fuel: { trucks: 0, withFuel: 0, comparable: 0, newestReading: null } }), { now: NOW }
  );
  assert.equal(find(all, 'eld_location_freshness').state, 'cannot_determine');
});

test('a notice stuck in the queue for hours means Telegram is not taking them', async () => {
  const all = await obs.gatherAllObservations(
    deps({ notifications: { abandoned: 0, pending: 4, oldestPendingAt: minutesAgo(60 * 5) } }),
    { now: NOW }
  );
  const tg = find(all, 'telegram_delivery');
  assert.equal(tg.ok, false);
  assert.match(tg.detail, /waiting 5 hours/);
});

test('a queue that gave up is the failure that silences every other alarm', async () => {
  const all = await obs.gatherAllObservations(
    deps({ notifications: { abandoned: 12, oldestPendingAt: null } }), { now: NOW }
  );
  assert.equal(find(all, 'notifications').ok, false);
  assert.match(find(all, 'notifications').detail, /12 notices gave up/);
});

test('the Samsara poller — a separate service — is seen through its heartbeat', async () => {
  const alive = await obs.gatherAllObservations(
    deps({ runMap: new Map([['samsara_safety_pipeline', run()]]) }), { now: NOW }
  );
  assert.equal(find(alive, 'samsara_safety_pipeline').state, 'healthy');

  const dead = await obs.gatherAllObservations(
    deps({ runMap: new Map([['samsara_safety_pipeline', run({ lastFinishedAt: minutesAgo(60 * 9) })]]) }),
    { now: NOW }
  );
  const d = find(dead, 'samsara_safety_pipeline');
  assert.equal(d.state, 'stale_stopped');
  assert.equal(d.ok, false,
    'an empty safety table is also what a quiet fleet looks like; only this row '
    + 'tells the two apart');
});

// ── configuration is not failure ─────────────────────────────────────────────

test('a feature nobody configured needs a person WITHOUT being a failure', async () => {
  const all = await obs.gatherAllObservations(deps({ recruiters: [], providers: [] }), { now: NOW });

  const rc = find(all, 'recruiter_logins');
  assert.equal(rc.state, 'needs_human_attention');
  assert.equal(rc.ok, true);

  const ai = find(all, 'ai_providers');
  assert.equal(ai.state, 'needs_human_attention');
  assert.equal(ai.ok, true);
});

test('one broken recruiter login is a person’s problem; all of them is an outage', async () => {
  const some = await obs.gatherAllObservations(deps({
    recruiters: [{ canSend: true, rc_auth_error: 'x' }, { canSend: true }],
  }), { now: NOW });
  assert.equal(find(some, 'recruiter_logins').ok, true);
  assert.match(find(some, 'recruiter_logins').detail, /1 of 2/);

  const all = await obs.gatherAllObservations(deps({
    recruiters: [{ canSend: true, rc_auth_error: 'x' }, { canSend: true, rc_auth_error: 'y' }],
  }), { now: NOW });
  assert.equal(find(all, 'recruiter_logins').ok, false);
});

test('a data layer that throws costs that one answer, never the whole pass', async () => {
  const broken = deps({});
  broken.rc.listRecruiters = async () => { throw new Error('no such table'); };
  broken.fuelReadings.summariseFuelReadings = async () => { throw new Error('no such table'); };

  const all = await obs.gatherAllObservations(broken, { now: NOW });
  assert.equal(find(all, 'recruiter_logins').state, 'cannot_determine');
  assert.equal(find(all, 'eld_location_freshness').state, 'cannot_determine');
  assert.ok(find(all, 'notifications'), 'and the rest still answered');
});
