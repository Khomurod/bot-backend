'use strict';

/**
 * The morning summary: once a day, in daylight, honest about what it could
 * not read, and never an id in a group chat.
 */
const test = require('node:test');
const assert = require('node:assert');

const { digestDayFor, ageOf, composeDigest } = require('../lib/control/digest');
const { runDailyDigest, digestKeyFor } = require('../services/control/dailyDigest');
const { noticeKeyFor } = require('../lib/notifications/compose');

// 2026-10-05 is a Monday; Chicago is UTC-5 in October.
const MORNING = new Date('2026-10-05T14:00:00Z'); // 09:00 local
const DAWN = new Date('2026-10-05T12:30:00Z'); //    07:30 local
const NIGHT = new Date('2026-10-06T01:30:00Z'); //   20:30 local, still the 5th

// ── when ────────────────────────────────────────────────────────────────────

test('due from 08:00 to 20:00 Chicago time, keyed by the local date', () => {
  assert.strictEqual(digestDayFor(MORNING), '2026-10-05');
  assert.strictEqual(digestDayFor(DAWN), null, 'not before eight');
  assert.strictEqual(digestDayFor(NIGHT), null, 'not a morning summary at night');
  assert.strictEqual(digestDayFor(new Date('2026-10-05T13:00:00Z')), '2026-10-05', '08:00 exactly');
});

test('the key it checks is the key notify writes', () => {
  assert.strictEqual(
    digestKeyFor('2026-10-05'),
    noticeKeyFor('needs_attention', 'control_digest', 'daily', '2026-10-05')
  );
});

test('ages in plain words', () => {
  assert.strictEqual(ageOf('2026-10-05T13:30:00Z', MORNING), 'today');
  assert.strictEqual(ageOf('2026-10-04T13:30:00Z', MORNING), 'yesterday');
  assert.strictEqual(ageOf('2026-10-01T13:30:00Z', MORNING), '4 days ago');
});

// ── what ────────────────────────────────────────────────────────────────────

test('the questions still waiting come first, the oldest named, the rest counted', () => {
  const out = composeDigest({
    waiting: [
      { title: 'Unit 310 on two profiles', askedAt: '2026-10-01T15:00:00Z' },
      { title: 'Open home stay', askedAt: '2026-10-04T15:00:00Z' },
      { title: 'Chat without a person', askedAt: '2026-10-05T13:30:00Z' },
    ],
    waitingTotal: 15,
    changes: { bySystem: 4, reverted: 1, revertedBySystem: 1 },
    findings: { serious: 1, warning: 6 },
    systemsDown: [],
    now: MORNING,
  });
  assert.strictEqual(out.title, 'Daily summary');
  assert.deepStrictEqual(out.lines, [
    'Waiting for your answer: 15',
    '• Unit 310 on two profiles — asked 4 days ago',
    '• Open home stay — asked yesterday',
    '• Chat without a person — asked today',
    '…and 12 more on Needs Attention.',
    'Done on my own in the last day: 4 changes (1 undone).',
    'Open problems: 1 serious · 6 warnings.',
    'All systems running.',
  ]);
});

test('a quiet day says so in words', () => {
  const out = composeDigest({
    waiting: [], waitingTotal: 0,
    changes: { bySystem: 0, reverted: 0 },
    findings: { serious: 0, warning: 0 },
    systemsDown: [],
    now: MORNING,
  });
  assert.deepStrictEqual(out.lines, [
    'No questions waiting for you.',
    'Nothing changed on its own in the last day.',
    'No open problems.',
    'All systems running.',
  ]);
});

test('NOTHING UNREAD IS REPORTED AS EMPTY — "no questions" from a failed read is a lie', () => {
  const out = composeDigest({ now: MORNING });
  assert.deepStrictEqual(out.lines, [
    'Could not read the questions, the changes, the open problems, system health this morning.',
  ]);
  assert.ok(!out.lines.includes('No questions waiting for you.'));
  assert.ok(!out.lines.includes('All systems running.'));
});

test('broken systems are named by their plain labels, at most three', () => {
  const out = composeDigest({ waiting: [], waitingTotal: 0, systemsDown: ['a', 'b', 'c', 'd', 'e'], now: MORNING });
  assert.ok(out.lines.includes('Needs a look: a, b, c and 2 more.'));
});

// ── the pass ────────────────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  const calls = { notified: [], keysChecked: [], waitingAsked: [] };
  const deps = {
    settings: { getControlSettings: async () => ({ enabled: true }) },
    notices: {
      noticeSentWithin: async (key) => { calls.keysChecked.push(key); return false; },
    },
    notificationSettings: {
      getNotificationSettings: async () => ({
        enabled: true, defaultChatId: '-100111', categoryChatIds: { needs_attention: '-100222' },
      }),
    },
    digest: {
      listWaitingQuestions: async (opts) => {
        calls.waitingAsked.push(opts);
        return { total: 2, oldest: [{ title: 'Open home stay', askedAt: '2026-10-03T15:00:00Z' }] };
      },
    },
    corrections: {
      summariseCorrections: async () => ({ bySystem: 3, reverted: 2, revertedBySystem: 0 }),
    },
    findings: { summariseFindings: async () => ({ serious: 0, warning: 2 }) },
    systemHealth: { summariseHealthStates: async () => ({ down: ['fuel_risk'] }) },
    notify: async (n) => { calls.notified.push(n); return { recorded: true }; },
  };
  return { ...deps, ...overrides, calls };
}

test('in the morning it sends one summary, keyed by the day', async () => {
  const deps = makeDeps();
  const out = await runDailyDigest({ now: MORNING }, deps);
  assert.strictEqual(out.sent, true);
  assert.strictEqual(deps.calls.notified.length, 1);
  const n = deps.calls.notified[0];
  assert.strictEqual(n.category, 'needs_attention');
  assert.strictEqual(n.discriminator, '2026-10-05');
  assert.strictEqual(n.subjectType, 'control_digest');
  assert.strictEqual(n.question, undefined, 'a summary asks nothing — it has no buttons');
  assert.ok(n.lines.includes('Waiting for your answer: 2'));
  assert.ok(n.lines.some((l) => /^Needs a look: /.test(l) && !/fuel_risk/.test(l)),
    'a worker is named by its label, never its key');
  assert.deepStrictEqual(deps.calls.keysChecked, [digestKeyFor('2026-10-05')]);
});

test('already sent today means nothing is built and nothing sent', async () => {
  const deps = makeDeps({ notices: { noticeSentWithin: async () => true } });
  const out = await runDailyDigest({ now: MORNING }, deps);
  assert.strictEqual(out.reason, 'already_sent');
  assert.strictEqual(deps.calls.notified.length, 0);
});

test('a failed "was it sent?" read is treated as sent — never two in a day', async () => {
  const deps = makeDeps({ notices: { noticeSentWithin: async () => { throw new Error('db'); } } });
  const out = await runDailyDigest({ now: MORNING }, deps);
  assert.strictEqual(out.sent, false);
  assert.strictEqual(deps.calls.notified.length, 0);
});

test('before eight, or with the channel switched off, nothing at all', async () => {
  const early = makeDeps();
  assert.strictEqual((await runDailyDigest({ now: DAWN }, early)).reason, 'not_the_hour');
  assert.strictEqual(early.calls.keysChecked.length, 0, 'no database read before the hour');

  const off = makeDeps({ settings: { getControlSettings: async () => ({ enabled: false }) } });
  assert.strictEqual((await runDailyDigest({ now: MORNING }, off)).reason, 'disabled');
  assert.strictEqual(off.calls.notified.length, 0);
});

test('a source that cannot be read is left out, the rest is still sent', async () => {
  const deps = makeDeps({
    digest: { listWaitingQuestions: async () => null },
    systemHealth: { summariseHealthStates: async () => { throw new Error('db'); } },
  });
  const out = await runDailyDigest({ now: MORNING }, deps);
  assert.strictEqual(out.sent, true);
  const { lines } = deps.calls.notified[0];
  assert.ok(lines.includes('Could not read the questions, system health this morning.'));
  assert.ok(!lines.includes('No questions waiting for you.'));
  assert.ok(lines.includes('Done on my own in the last day: 3 changes.'));
});

// ── review findings, PR #255 ────────────────────────────────────────────────

test('TITLES ONLY FROM QUESTIONS ASKED IN THE CHAT THE SUMMARY GOES TO', async () => {
  // Codex P1: after the destination changes, old questions keep their old
  // chat — naming them in the new chat would show finding titles to a group
  // that never received them.
  const deps = makeDeps();
  await runDailyDigest({ now: MORNING }, deps);
  assert.deepEqual(deps.calls.waitingAsked, [{ limit: 3, chatId: '-100222' }],
    'scoped to the needs_attention override, not the default');
});

test('with nowhere to send it, nothing is read and nothing is sent', async () => {
  const deps = makeDeps({
    notificationSettings: { getNotificationSettings: async () => ({ enabled: true, defaultChatId: null, categoryChatIds: {} }) },
  });
  const out = await runDailyDigest({ now: MORNING }, deps);
  assert.equal(out.reason, 'no_destination');
  assert.equal(deps.calls.waitingAsked.length, 0);
  assert.equal(deps.calls.notified.length, 0);
});

test('"undone" counts only automatic changes that were undone', () => {
  // Codex P2: one live automatic change plus one reverted ADMIN change read
  // "1 change (1 undone)", as though Wenze's own change had been undone.
  const out = composeDigest({
    waiting: [], waitingTotal: 0, changes: { bySystem: 1, reverted: 1, revertedBySystem: 0 },
    findings: { serious: 0, warning: 0 }, systemsDown: [], now: MORNING,
  });
  assert.ok(out.lines.includes('Done on my own in the last day: 1 change.'));
});

test('a system switched off or waiting on a setting is never "all systems running"', () => {
  // Codex P2: `blocked` components are in `waiting`, never in `down`.
  const out = composeDigest({
    waiting: [], waitingTotal: 0, systemsDown: [], systemsWaiting: ['the leads bot'], now: MORNING,
  });
  assert.ok(!out.lines.includes('All systems running.'));
  assert.ok(out.lines.includes('Nothing is broken. Waiting on a setting: the leads bot.'));

  const both = composeDigest({
    waiting: [], waitingTotal: 0, systemsDown: ['fuel'], systemsWaiting: ['leads'], now: MORNING,
  });
  assert.ok(both.lines.includes('Needs a look: fuel.'));
  assert.ok(both.lines.includes('Waiting on a setting: leads.'));
});

test('the pass hands the waiting components over by label', async () => {
  const deps = makeDeps({
    systemHealth: { summariseHealthStates: async () => ({ down: [], waiting: ['leads_bot'] }) },
  });
  await runDailyDigest({ now: MORNING }, deps);
  const { lines } = deps.calls.notified[0];
  assert.ok(lines.some((l) => /^Nothing is broken\. Waiting on a setting: /.test(l) && !/leads_bot/.test(l)), lines.join(' | '));
});
