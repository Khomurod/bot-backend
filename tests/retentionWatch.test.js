'use strict';

/**
 * Saying that the company is about to lose a driver, in time for somebody to
 * do something about it.
 *
 * Two lines this file holds:
 *
 *   THE DECISION HAS NO MODEL IN IT. With every provider dead, exactly the same
 *   drivers are flagged for exactly the same reasons; only one sentence is
 *   worded differently.
 *
 *   NOTHING HERE DECIDES ANYTHING ABOUT SOMEBODY'S JOB. The notice goes to the
 *   operations chat, never to the driver, and a body that strays into an
 *   employment decision is refused whole.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const watch = require('../services/retention/watch');

const NOW = Date.parse('2026-09-11T00:00:00Z');
const nowIso = new Date(NOW).toISOString();

const CALM = {
  personId: 11, groupId: 7, driverName: 'Sam Rivera',
  quitSignals: 0, complaints: 0, avgSentiment: 0.2,
  baselineMessages: 20, recentMessages: 18,
  daysOnRoad: 10, roadWeeksOverAllowance: 0,
  unansweredHomeRequests: 0, deniedHomeRequests: 0,
  unpaidBonusUsd: 0, unpaidBonusCount: 0,
  emptySince: null, brokenHomeCommitments: 0, raiseNotQualifiedRounds: 0,
};
// score 10 → urgent: a broken promise, weeks over the allowance and unpaid money.
const AT_RISK = {
  ...CALM, roadWeeksOverAllowance: 3, unansweredHomeRequests: 1, unpaidBonusUsd: 300,
};
// score 4 → watch: enough to be worth a call, not enough to interrupt somebody.
const WORTH_WATCHING = { ...CALM, deniedHomeRequests: 2, complaints: 2 };

function harness({
  drivers = [AT_RISK], previous = null, aiText = null, aiThrows = false,
  aiEnabled = true, gatherThrows = false,
} = {}) {
  const calls = { notified: [], recorded: [], marked: [], prompts: [] };
  const deps = {
    inputs: {
      async gatherRetentionInputs() {
        if (gatherThrows) throw new Error('database is down');
        return drivers;
      },
    },
    store: {
      async getAssessment() { return previous; },
      async recordAssessment(row) { calls.recorded.push(row); return { ...row, id: 1 }; },
      shouldNotify: require('../database/retentionAssessments').shouldNotify,
      async markNotified(id, score) { calls.marked.push({ id, score }); return {}; },
    },
    async notify(n) { calls.notified.push(n); return { recorded: true, delivered: true }; },
    async isCapabilityEnabled() { return aiEnabled; },
    async runCapability(req) {
      calls.prompts.push(req);
      if (aiThrows) throw new Error('every provider is down');
      return { text: aiText };
    },
  };
  return { deps, calls };
}

test('a driver with nothing wrong is recorded and nobody is told', async () => {
  const { deps, calls } = harness({ drivers: [CALM] });
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.checked, 1);
  assert.equal(summary.flagged, 0);
  assert.deepEqual(calls.notified, []);
  assert.equal(calls.recorded[0].level, 'none', 'recorded even at none, so a rise is detectable');
});

test('a driver at risk produces one notice with the reasons and a thing to do', async () => {
  const { deps, calls } = harness();
  const summary = await watch.runRetentionPass({ now: NOW, deps });

  assert.equal(summary.flagged, 1);
  assert.equal(summary.notified, 1);
  const notice = calls.notified[0];
  assert.equal(notice.category, 'retention', 'the operations chat, never the driver\'s');
  assert.ok(notice.lines.length >= 2, 'the reasons, not just a verdict');
  assert.match(notice.action, /^(Ring|Answer|Get|Check|Find|Read|Tell)/, 'something a person DOES');
  assert.equal(calls.marked.length, 1, 'what was announced is recorded');
});

test('WITH EVERY PROVIDER DEAD THE SAME DRIVER IS FLAGGED FOR THE SAME REASONS', async () => {
  const withAi = harness({ aiText: 'They have been out three weeks past the allowance with a request still unanswered.' });
  const withoutAi = harness({ aiThrows: true });

  const a = await watch.runRetentionPass({ now: NOW, deps: withAi.deps });
  const b = await watch.runRetentionPass({ now: NOW, deps: withoutAi.deps });

  assert.deepEqual(
    { flagged: a.flagged, notified: a.notified },
    { flagged: b.flagged, notified: b.notified },
  );
  assert.deepEqual(
    withAi.calls.notified[0].lines,
    withoutAi.calls.notified[0].lines,
    'the reasons are arithmetic and do not depend on a model',
  );
  assert.notEqual(withAi.calls.notified[0].title, withoutAi.calls.notified[0].title,
    'only the one sentence differs');
});

test('the responsibility switch turns off the wording, not the feature', async () => {
  const { deps, calls } = harness({ aiEnabled: false });
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.notified, 1);
  assert.deepEqual(calls.prompts, [], 'no model was asked');
  assert.match(calls.notified[0].title, /Sam Rivera/);
});

test('a model that reaches for an employment decision is refused', async () => {
  const { deps, calls } = harness({
    aiText: 'This driver is unreliable and should be considered for replacement.',
  });
  await watch.runRetentionPass({ now: NOW, deps });
  const title = calls.notified[0].title;
  assert.ok(!/replacement|unreliable/i.test(title), 'the refused wording never ships');
  assert.match(title, /expired without an answer|road allowance|bonus/i, 'the fixed sentence went instead');
});

test('the validator handed to the router is the real guard, not a stub', async () => {
  const { deps, calls } = harness({ aiText: 'Out three weeks past the allowance, request unanswered.' });
  await watch.runRetentionPass({ now: NOW, deps });
  const call = calls.prompts[0];
  assert.equal(typeof call.validate, 'function', 'the router reads `validate`');
  assert.notEqual(call.validate('They should be terminated for this.'), true);
  assert.equal(call.validate('Out three weeks past the allowance with a request unanswered.'), true);
});

test('the prompt carries reasons and counts, never the driver\'s name or their words', async () => {
  const { deps, calls } = harness({ aiText: 'Three weeks past the allowance.' });
  await watch.runRetentionPass({ now: NOW, deps });
  const prompt = calls.prompts[0].userText;
  assert.ok(!prompt.includes('Sam Rivera'), 'no name goes to a provider');
  assert.match(prompt, /past the road allowance/);
  assert.match(prompt, /Never characterise the driver/);
});

test('a notice is not repeated on the next pass', async () => {
  const previous = { id: 1, notifiedAt: nowIso, notifiedScore: 9, acknowledgedAt: null };
  const { deps, calls } = harness({ previous });
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.flagged, 1, 'still at risk');
  assert.equal(summary.notified, 0, 'and still not worth saying again');
  assert.deepEqual(calls.notified, []);
});

test('but it IS repeated when it gets materially worse', async () => {
  const previous = { id: 1, notifiedAt: nowIso, notifiedScore: 3, acknowledgedAt: null };
  const { deps, calls } = harness({ previous, drivers: [{ ...AT_RISK, quitSignals: 1 }] });
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.notified, 1);
  assert.equal(calls.notified.length, 1);
});

test('an acknowledged driver goes quiet until it gets worse than what was acknowledged', async () => {
  const acknowledged = { id: 1, notifiedAt: nowIso, notifiedScore: 10, acknowledgedAt: nowIso };
  const quiet = harness({ previous: acknowledged });
  assert.equal((await watch.runRetentionPass({ now: NOW, deps: quiet.deps })).notified, 0);

  const worse = harness({
    previous: acknowledged,
    drivers: [{ ...AT_RISK, quitSignals: 2, complaints: 4, brokenHomeCommitments: 2 }],
  });
  assert.equal((await watch.runRetentionPass({ now: NOW, deps: worse.deps })).notified, 1,
    'an acknowledgement must not buy silence for a situation that is deteriorating');
});

test('a database failure is a reported error, not a crash and not a false all-clear', async () => {
  const { deps, calls } = harness({ gatherThrows: true });
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.checked, 0);
  assert.equal(summary.errors.length, 1);
  assert.deepEqual(calls.notified, []);
});

test('one bad driver row costs that row only', async () => {
  const { deps, calls } = harness({ drivers: [AT_RISK, { ...AT_RISK, personId: 12, driverName: 'Other' }] });
  let first = true;
  const original = deps.store.recordAssessment;
  deps.store.recordAssessment = async (row) => {
    if (first) { first = false; throw new Error('write failed'); }
    return original(row);
  };
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.checked, 2);
  assert.equal(summary.errors.length, 1);
  assert.equal(calls.notified.length, 1, 'the second driver was still handled');
});

// ── the guard itself ────────────────────────────────────────────────────────

test('the employment-language guard refuses what it must', () => {
  for (const bad of [
    'This driver should be terminated.',
    'Consider a replacement for this seat.',
    'Their attitude has been a problem.',
    'Time for a written warning... write-up pending.',
    'Put them on a performance plan.',
    'They are unreliable.',
    'We should let them go.',
  ]) {
    assert.equal(watch.refuseEmploymentLanguage(bad).ok, false, bad);
  }
});

test('and allows what a retention notice actually says', () => {
  for (const good of [
    'Three weeks past the road allowance with a home request still unanswered.',
    '$300 of earned bonus has not been paid.',
    'Sitting empty for six days.',
    'They have said something about leaving.',
  ]) {
    assert.equal(watch.refuseEmploymentLanguage(good).ok, true, good);
  }
});

test('the fallback sentence names the heaviest reason and how many others', () => {
  const text = watch.buildFallbackSummary({
    driverName: 'Sam Rivera',
    assessment: {
      topReason: '3 weeks past the road allowance',
      signals: [{ detail: 'a' }, { detail: 'b' }, { detail: 'c' }],
    },
  });
  assert.match(text, /^Sam Rivera: 3 weeks past the road allowance, and 2 other things\.$/);
});

// ── fifty notices is not fifty times the information ─────────────────────────

/**
 * Production answered this within half an hour of going live: fifty drivers
 * came back at `watch` on a fleet of about a hundred and ten — truthfully,
 * because this fleet really does have that many people past the road allowance
 * with home requests that expired.
 *
 * Fifty separate messages is a channel nobody opens again, and it would have
 * landed the moment somebody configured a destination.
 */
test('a WATCH driver gets no message of their own', async () => {
  const { deps, calls } = harness({ drivers: [WORTH_WATCHING] });
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.flagged, 1);
  assert.equal(summary.notified, 0, 'no individual notice');
  assert.equal(calls.notified.length, 1, 'one cohort notice instead');
  assert.match(calls.notified[0].title, /1 driver worth a call/);
});

test('an URGENT driver still gets their own message', async () => {
  const { deps, calls } = harness({ drivers: [AT_RISK] });
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.urgent, 1);
  assert.equal(summary.notified, 1);
  assert.equal(calls.notified.length, 1);
  assert.match(calls.notified[0].title, /Sam Rivera/);
});

test('fifty watch drivers produce ONE message naming the worst five', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    ...WORTH_WATCHING,
    personId: 100 + i,
    driverName: `Driver ${i}`,
    // Make a few clearly worse so the ordering is observable.
    roadWeeksOverAllowance: i < 5 ? 3 : 0,
  }));
  const { deps, calls } = harness({ drivers: many });
  const summary = await watch.runRetentionPass({ now: NOW, deps });

  assert.equal(summary.checked, 50);
  assert.equal(calls.notified.length, 1, 'ONE message, not fifty');
  const notice = calls.notified[0];
  assert.match(notice.title, /50 drivers worth a call/);
  assert.equal(notice.lines.length, watch.COHORT_NAMED + 1, 'five named plus the remainder line');
  assert.match(notice.lines[notice.lines.length - 1], /and 45 more/);
  assert.match(notice.action, /Operations → Retention/);
});

test('the named ones are the worst ones', async () => {
  const drivers = [
    { ...WORTH_WATCHING, personId: 1, driverName: 'Mild' },
    { ...WORTH_WATCHING, personId: 2, driverName: 'Worse', roadWeeksOverAllowance: 3 },
  ];
  const { deps, calls } = harness({ drivers });
  await watch.runRetentionPass({ now: NOW, deps });
  assert.match(calls.notified[0].lines[0], /^Worse:/);
});

test('only the NAMED drivers are stamped as told — the rest can be named later', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    ...WORTH_WATCHING, personId: 200 + i, driverName: `D${i}`,
  }));
  const { deps, calls } = harness({ drivers: many });
  await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(calls.marked.length, watch.COHORT_NAMED,
    'a driver who only made the count is still name-able on a later pass');
});

test('a cohort notice that failed to send stamps nobody', async () => {
  const { deps, calls } = harness({ drivers: [WORTH_WATCHING] });
  deps.notify = async () => ({ recorded: false, delivered: false, reason: 'no_destination' });
  await watch.runRetentionPass({ now: NOW, deps });
  assert.deepEqual(calls.marked, [], 'nobody is recorded as told when nothing was sent');
});

test('a quiet fleet sends nothing at all', async () => {
  const { deps, calls } = harness({ drivers: [CALM, { ...CALM, personId: 12 }] });
  const summary = await watch.runRetentionPass({ now: NOW, deps });
  assert.equal(summary.flagged, 0);
  assert.deepEqual(calls.notified, []);
});
