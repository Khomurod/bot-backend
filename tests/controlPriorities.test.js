'use strict';

/**
 * "Most important today" in the morning summary: rules choose the candidates
 * and their order; an AI may only choose among them and say them plainly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  candidatesForToday, buildPrioritiesPrompt, validatePriorities,
  fallbackPriorities, prioritiesFromPicks, CANDIDATES,
} = require('../lib/control/priorities');
const { runDailyDigest } = require('../services/control/dailyDigest');

const MORNING = new Date('2026-10-05T14:00:00Z');
const f = (id, over = {}) => ({
  id, title: `Problem ${id}`, severity: 'warning', firstSeenAt: '2026-10-01T00:00:00Z', ...over,
});

test('candidates: rule order, capped, titled only', () => {
  const list = [
    f(1), f(2, { severity: 'serious' }), f(3, { checkKey: 'home_time.road_bonus_review' }),
    f(4, { title: null }), ...Array.from({ length: 10 }, (_, i) => f(10 + i, { severity: 'info' })),
  ];
  const c = candidatesForToday(list);
  assert.equal(c.length, CANDIDATES);
  assert.deepEqual(c.slice(0, 3).map((x) => x.id), [3, 2, 1]);
  assert.ok(!c.some((x) => x.id === 4));
});

test('the prompt lists only what was given, numbered', () => {
  const p = buildPrioritiesPrompt([f(1), f(2)], MORNING);
  assert.match(p, /1\. \[warning\] Problem 1 \(open 4 days\)/);
  assert.match(p, /2\. \[warning\] Problem 2/);
});

test('a pick must name a given item, once; at most three', () => {
  const v = validatePriorities([f(1), f(2), f(3), f(4)]);
  assert.equal(v(null, { picks: [{ item: 2, line: 'a' }, { item: 1, line: 'b' }] }), true);
  assert.notEqual(v(null, { picks: [{ item: 9, line: 'invented' }] }), true);
  assert.notEqual(v(null, { picks: [{ item: 1, line: 'a' }, { item: 1, line: 'a' }] }), true);
  assert.notEqual(v(null, { picks: [1, 2, 3, 4].map((n) => ({ item: n, line: 'x' })) }), true);
  assert.notEqual(v(null, { picks: [] }), true);
});

test('without AI, or with a refused answer: the first three by rule', () => {
  const c = [f(1), f(2), f(3), f(4)];
  assert.deepEqual(fallbackPriorities(c), ['Problem 1', 'Problem 2', 'Problem 3']);
  assert.deepEqual(prioritiesFromPicks(c, { picks: [{ item: 7, line: 'x' }] }), fallbackPriorities(c));
  assert.deepEqual(prioritiesFromPicks(c, { picks: [{ item: 2, line: 'Pay Unit 310 or not.' }] }),
    ['Pay Unit 310 or not.']);
});

function digestDeps(extra = {}) {
  const calls = { notified: [] };
  return {
    calls,
    settings: { getControlSettings: async () => ({ enabled: true }) },
    notices: { noticeSentWithin: async () => false },
    notificationSettings: { getNotificationSettings: async () => ({ enabled: true, defaultChatId: '-1001' }) },
    digest: { listWaitingQuestions: async () => ({ total: 0, oldest: [] }) },
    corrections: { summariseCorrections: async () => ({ bySystem: 0, revertedBySystem: 0 }) },
    findings: {
      summariseFindings: async () => ({ serious: 1, warning: 1 }),
      listFindings: async () => [f(1), f(2, { severity: 'serious', title: 'Truck 310 has no driver' })],
    },
    systemHealth: { summariseHealthStates: async () => ({ down: [], waiting: [] }) },
    notify: async (n) => { calls.notified.push(n); return { recorded: true }; },
    ...extra,
  };
}

test('the summary OPENS with today\'s most important, worded by AI', async () => {
  const deps = digestDeps({
    runCapability: async () => ({ parsed: { picks: [{ item: 1, line: 'Truck 310 needs a driver today.' }] } }),
  });
  await runDailyDigest({ now: MORNING }, deps);
  const { lines } = deps.calls.notified[0];
  assert.equal(lines[0], 'Most important today:');
  assert.equal(lines[1], '1. Truck 310 needs a driver today.');
});

test('AI unavailable: the same line, from the rules', async () => {
  const deps = digestDeps({ runCapability: async () => { throw new Error('no provider'); } });
  await runDailyDigest({ now: MORNING }, deps);
  const { lines } = deps.calls.notified[0];
  assert.deepEqual(lines.slice(0, 3), ['Most important today:', '1. Truck 310 has no driver', '2. Problem 1']);
});

test('nothing open: no priorities line, and the rest of the summary as before', async () => {
  const deps = digestDeps();
  deps.findings.listFindings = async () => [];
  await runDailyDigest({ now: MORNING }, deps);
  assert.ok(!deps.calls.notified[0].lines.includes('Most important today:'));
});
