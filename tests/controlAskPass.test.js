'use strict';

/**
 * What gets asked, and — more importantly — what does not.
 *
 * The four noise guards are the substance of this file: the cap, the repeat
 * window, the tier rule, and the wording allow-list. A control channel that
 * asks forty questions a pass ends with the group muted, which is the same
 * silence this whole feature exists to remove.
 */
const test = require('node:test');
const assert = require('node:assert');

const { runAskPass, isAskableFinding, askRoundFor, questionKeyFor } = require('../services/control/askPass');
const { fingerprintFor } = require('../lib/control/fingerprint');
const { noticeKeyFor } = require('../lib/notifications/compose');
const { whyAsking: whyFor, WHY_BY_CHECK } = require('../lib/control/priority');

function finding(over = {}) {
  return {
    id: 11, checkKey: 'identity.stale_unit_assignment', status: 'open', tier: 'auto',
    subjectType: 'group', subjectId: '49', confidence: 90, severity: 'warning',
    title: 'Truck on the profile does not match', evidence: { personId: 5 },
    firstSeenAt: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  };
}

function makeDeps(over = {}) {
  const calls = { notified: [], decisions: [] };
  return {
    calls,
    findings: { listFindings: async () => [finding()] },
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 0 },
    settings: {
      getControlSettings: async () => ({
        enabled: true, maxQuestionsPerPass: 5, repeatAfterHours: 72, clarifyLimit: 1,
      }),
    },
    notify: async (n) => { calls.notified.push(n); return { recorded: true }; },
    actionForCheck: () => ({ key: 'identity.sync_unit', tier: 'auto' }),
    payloadFor: () => ({ personId: 5, unitNumber: '322' }),
    loadCheckSettings: async () => new Map([['identity.stale_unit_assignment', { mode: 'suggest' }]]),
    takeDecision: async (d) => { calls.decisions.push(d); return { id: 44 }; },
    ...over,
  };
}

test('a suggest-mode auto finding with an action is asked about', async () => {
  const deps = makeDeps();
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 1);
  const n = deps.calls.notified[0];
  assert.match(n.title, /\?$/);
  assert.strictEqual(n.subjectType, 'control_question');
  assert.strictEqual(n.findingId, 11);
  assert.deepStrictEqual(
    n.question.offeredActions.map((o) => o.key), ['approve', 'dismiss', 'snooze']
  );
});

test('THE VISIBLE TEXT NEVER NAMES AN ACTION', async () => {
  const deps = makeDeps();
  await runAskPass({}, deps);
  const n = deps.calls.notified[0];
  const visible = [n.title, ...(n.lines || []), n.action].join(' ');
  assert.ok(!visible.includes('identity.sync_unit'), visible);
  assert.ok(!/approve|dismiss|snooze/.test(visible), visible);
});

test('a check already in autopilot is not asked about — it just does it', async () => {
  const deps = makeDeps({
    loadCheckSettings: async () => new Map([['identity.stale_unit_assignment', { mode: 'autopilot' }]]),
  });
  assert.strictEqual((await runAskPass({}, deps)).asked, 0);
});

test('a warning-tier finding is never a question — there is nothing to approve', async () => {
  const deps = makeDeps({ findings: { listFindings: async () => [finding({ tier: 'warning' })] } });
  assert.strictEqual((await runAskPass({}, deps)).asked, 0);
});

test('an approval-tier finding IS asked about, whatever the mode', async () => {
  const deps = makeDeps({
    findings: { listFindings: async () => [finding({ tier: 'approval' })] },
    loadCheckSettings: async () => new Map(),
  });
  assert.strictEqual((await runAskPass({}, deps)).asked, 1);
});

test('a check with no question wording never asks', async () => {
  const deps = makeDeps({
    findings: { listFindings: async () => [finding({ checkKey: 'something.invented' })] },
    loadCheckSettings: async () => new Map([['something.invented', { mode: 'suggest' }]]),
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.skipped.noWording, 1);
});

test('THE CAP HOLDS, and the oldest are asked first', async () => {
  const many = Array.from({ length: 12 }, (_, i) => finding({
    id: 100 + i,
    firstSeenAt: new Date(Date.now() - (i + 1) * 86400_000).toISOString(),
  }));
  const deps = makeDeps({
    findings: { listFindings: async () => many },
    settings: {
      getControlSettings: async () => ({
        enabled: true, maxQuestionsPerPass: 3, repeatAfterHours: 72, clarifyLimit: 1,
        maxQuestionsPerDay: 10,
      }),
    },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 3);
  // 111 is the oldest (12 days), then 110, then 109.
  assert.deepStrictEqual(deps.calls.notified.map((n) => n.findingId), [111, 110, 109]);
});

test('the same question is not repeated inside the window', async () => {
  const deps = makeDeps({
    notices: { noticeSentWithin: async () => true, countUnansweredQuestions: async () => 0 },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.skipped.recentlyAsked, 1);
});

test('A FAILED SUPPRESSION READ MEANS SILENCE, NOT A SECOND QUESTION', async () => {
  const deps = makeDeps({
    notices: {
      noticeSentWithin: async () => { throw new Error('down'); },
      countUnansweredQuestions: async () => 0,
    },
  });
  assert.strictEqual((await runAskPass({}, deps)).asked, 0);
});

test('switched off asks nothing at all', async () => {
  const deps = makeDeps({ settings: { getControlSettings: async () => ({ enabled: false }) } });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.reason, 'disabled');
  assert.strictEqual(deps.calls.notified.length, 0);
});

test('THE SUGGESTION IS JOURNALLED — this is what finally writes suggest rows', async () => {
  const deps = makeDeps();
  await runAskPass({}, deps);
  assert.strictEqual(deps.calls.decisions.length, 1);
  assert.strictEqual(deps.calls.decisions[0].mode, 'suggest');
  assert.strictEqual(deps.calls.decisions[0].shadow, false);
  assert.strictEqual(deps.calls.notified[0].question.decisionId, 44);
});

test('the suppression prefix is the key notify actually writes, and is unambiguous', () => {
  const real = noticeKeyFor('needs_attention', 'control_question', '42', 'r0');
  assert.ok(real.startsWith(questionKeyFor(42)));
  // Finding 4 must not suppress finding 42.
  assert.ok(!real.startsWith(questionKeyFor(4)));
});

test('a re-ask after the window gets a key of its own', () => {
  const first = new Date(Date.now() - 200 * 3600_000).toISOString();
  assert.strictEqual(askRoundFor({ firstSeenAt: first }, 72), 2);
  assert.strictEqual(askRoundFor({ firstSeenAt: new Date().toISOString() }, 72), 0);
  assert.strictEqual(askRoundFor({}, 72), 0, 'no first-seen is round zero, not a crash');
});

test('the askable rule, stated once and read here', () => {
  assert.strictEqual(isAskableFinding(finding(), { mode: 'suggest', hasAction: true }), true);
  assert.strictEqual(isAskableFinding(finding(), { mode: 'autopilot', hasAction: true }), false);
  assert.strictEqual(isAskableFinding(finding(), { mode: 'suggest', hasAction: false }), false);
  assert.strictEqual(isAskableFinding(finding({ tier: 'approval' }), { mode: null, hasAction: true }), true);
  assert.strictEqual(isAskableFinding(finding({ status: 'dismissed' }), { mode: 'suggest', hasAction: true }), false);
});

test('THE STANDING CAP: nothing new is asked while the owner is still answering', async () => {
  // The per-pass cap limits one pass; this sweep runs every fifteen minutes.
  // Without this guard the first day after a deploy delivers hundreds of
  // questions into a group that has answered none of them.
  const deps = makeDeps({
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 5 },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.reason, 'waiting_for_answers');
  assert.strictEqual(deps.calls.notified.length, 0);
});

test('the standing cap counts against the per-pass cap, not beside it', async () => {
  const many = Array.from({ length: 6 }, (_, i) => finding({ id: 200 + i }));
  const deps = makeDeps({
    findings: { listFindings: async () => many },
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 3 },
  });
  // Three already out, five allowed: room for two more, not five.
  assert.strictEqual((await runAskPass({}, deps)).asked, 2);
});

test('A FAILED OUTSTANDING COUNT MEANS SILENCE, not permission to ask more', async () => {
  const deps = makeDeps({
    notices: {
      noticeSentWithin: async () => false,
      countUnansweredQuestions: async () => { throw new Error('down'); },
    },
  });
  assert.strictEqual((await runAskPass({}, deps)).asked, 0);
});

/**
 * A memory that the pass cannot reach is a memory that does nothing, and the
 * two ways it could be unreachable are both here.
 */
function memoryDeps(over = {}) {
  const closed = [];
  const target = finding({
    checkKey: 'board.truck_disagrees_with_profile', tier: 'approval',
    evidence: { personId: 5, profileUnit: '310', boardTruck: '311' },
  });
  const memory = {
    id: 3,
    checkKey: target.checkKey, subjectType: target.subjectType, subjectId: target.subjectId,
    answerAction: 'dismiss', answerText: 'He swapped trucks.',
    evidenceFingerprint: fingerprintFor(target),
    revokedAt: null, expiresAt: null,
  };
  const deps = makeDeps({
    findings: {
      listFindings: async () => [target],
      dismissFinding: async (id, patch) => { closed.push({ id, ...patch }); return { id }; },
    },
    knowledge: { findMemory: async () => memory, noteApplied: async () => memory },
    ...over,
  });
  deps.calls.closed = closed;
  return deps;
}

test('A QUESTION THE OWNER ALREADY ANSWERED IS CLOSED INSTEAD OF ASKED', async () => {
  const deps = memoryDeps();
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.skipped.remembered, 1);
  assert.strictEqual(deps.calls.notified.length, 0, 'nothing was sent to the group');
  assert.strictEqual(deps.calls.closed.length, 1);
  assert.match(deps.calls.closed[0].reason, /Already answered/);
});

test('THE STANDING CAP DOES NOT BLOCK A MEMORY — closing costs nobody anything', async () => {
  // Folded into the ask loop this was a real defect: with five questions
  // outstanding the pass returned early and every settled finding sat open in
  // the admin until somebody replied to something unrelated.
  const deps = memoryDeps({
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 5 },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.reason, 'waiting_for_answers');
  assert.strictEqual(got.skipped.remembered, 1);
  assert.strictEqual(deps.calls.closed.length, 1, 'the settled finding was still closed');
  assert.strictEqual(deps.calls.notified.length, 0);
});

test('a memory for a DIFFERENT situation does not stop the question', async () => {
  const deps = memoryDeps({
    knowledge: {
      findMemory: async () => ({
        id: 3, checkKey: 'board.truck_disagrees_with_profile',
        subjectType: 'group', subjectId: '49',
        answerAction: 'dismiss', answerText: 'old answer',
        evidenceFingerprint: 'a'.repeat(32), revokedAt: null, expiresAt: null,
      }),
      noteApplied: async () => null,
    },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.skipped.remembered, 0);
  assert.strictEqual(deps.calls.closed.length, 0);
  assert.strictEqual(got.asked, 1, 'it was asked, as a new situation should be');
});

test('a pass with no memory store still asks — the read fails open', async () => {
  const deps = makeDeps({ knowledge: undefined });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 1);
});

/**
 * The case that fell through every gap: a check the owner PERMITTED to act,
 * which decided not to, and then said nothing to anybody.
 */
function heldDeps(over = {}) {
  const target = finding({ tier: 'auto' });
  const deps = makeDeps({
    loadCheckSettings: async () => new Map([
      ['identity.stale_unit_assignment', { mode: 'autopilot' }],
    ]),
    decisions: {
      async currentHolds() {
        return new Map([[
          `${target.checkKey}|${target.subjectType}|${target.subjectId}`,
          { verdict: 'hold', reason: 'confidence 62 below the floor of 75', checkKey: target.checkKey },
        ]]);
      },
    },
    ...over,
  });
  return deps;
}

test('AN AUTOPILOT CHECK THAT HELD IS ASKED ABOUT — silence is the worst of both settings', async () => {
  const deps = heldDeps();
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 1);
  const n = deps.calls.notified[0];
  // WHY IT IS BEING ASKED has to be in the message. Without it the owner reads
  // a question about something they already told Wenze it could handle.
  assert.match(n.lines.join(' '), /not sure enough/i);
});

test('an autopilot check with nothing held is still not asked about', async () => {
  const deps = heldDeps({ decisions: { async currentHolds() { return new Map(); } } });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.skipped.notAskable, 1);
});

test('an "I cannot tell" says so in its own words, not the journal\'s', async () => {
  const deps = heldDeps({
    decisions: {
      async currentHolds() {
        return new Map([[
          'identity.stale_unit_assignment|group|49',
          { verdict: 'unknown', reason: 'no usable source for identity.sync_unit' },
        ]]);
      },
    },
  });
  await runAskPass({}, deps);
  const lines = deps.calls.notified[0].lines.join(' ');
  assert.match(lines, /could not tell/i);
  // THE CHECK KEY MUST NOT TRAVEL. The journal's reason names it; the question
  // may never, because a key in a group chat is both meaningless to the reader
  // and a hint to somebody who should not be able to name an action.
  assert.ok(!/identity\.sync_unit/.test(lines));
});

test('the journal records that the suggestion followed a hold', async () => {
  const deps = heldDeps();
  await runAskPass({}, deps);
  assert.strictEqual(deps.calls.decisions[0].evidence.afterHold, 'hold');
});

test('a decisions reader that fails costs the extra questions, not the pass', async () => {
  const deps = heldDeps({
    decisions: { async currentHolds() { throw new Error('journal is down'); } },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0, 'it went quiet rather than guessing');
  assert.strictEqual(got.skipped.notAskable, 1);
});

/**
 * A SETTINGS READ THAT FAILED CHANGES WHAT THIS PASS DECIDES.
 *
 * The per-check mode map was read with `.catch(() => new Map())`. An empty map
 * makes every auto-tier finding read as "not in suggest mode", so the pass
 * silently skipped all of them, asked only the approval-tier questions, and
 * returned a summary indistinguishable from a healthy pass with nothing to ask.
 * A feature quietly half-working is the defect class; saying so is the fix.
 */
test('a mode map that could not be read is reported, not silently skipped past', async () => {
  const deps = makeDeps({
    loadCheckSettings: async () => { throw new Error('permission denied'); },
  });
  const got = await runAskPass({}, deps);

  assert.strictEqual(got.asked, 0, 'the auto-tier finding cannot be judged, so it is not asked');
  assert.match(got.error, /per-check modes could not be read/,
    '`error` singular is the field the ledger reads — without it this is a clean run');
  assert.match(got.error, /permission denied/, 'and it names what went wrong');
});

/** A readable map still returns no error, so the signal means something. */
test('a pass that read its settings carries no error', async () => {
  const got = await runAskPass({}, makeDeps());
  assert.strictEqual(got.error, undefined);
});

// ── one or two a day, the most important first (owner, 2026-10-06) ─────────

test('AT MOST the daily budget, counted from what already went out today', async () => {
  const many = Array.from({ length: 6 }, (_, i) => finding({ id: 300 + i }));
  const deps = makeDeps({ findings: { listFindings: async () => many } });
  deps.digest = { countQuestionsAskedSince: async () => 1 };
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 1, 'two a day, one already asked');
});

test('a spent budget asks nothing and says why', async () => {
  const deps = makeDeps();
  deps.digest = { countQuestionsAskedSince: async () => 2 };
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.reason, 'daily_limit');
});

test('a count that FAILED is a spent budget, never an empty one', async () => {
  const deps = makeDeps();
  deps.digest = { countQuestionsAskedSince: async () => { throw new Error('db down'); } };
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.reason, 'daily_limit');
});

test('the database is asked for findings IN QUESTION ORDER, before its limit (review, #263)', async () => {
  const seen = [];
  const deps = makeDeps({ findings: { listFindings: async (q) => { seen.push(q); return [finding()]; } } });
  deps.digest = { countQuestionsAskedSince: async () => 0 };
  await runAskPass({}, deps);
  assert.equal(seen[0].order, 'ask');
});

test('serious is asked before an older warning', async () => {
  const old = new Date(Date.now() - 9 * 86400_000).toISOString();
  const fresh = new Date().toISOString();
  const list = [
    finding({ id: 401, severity: 'warning', firstSeenAt: old }),
    finding({ id: 402, severity: 'serious', firstSeenAt: fresh }),
  ];
  const deps = makeDeps({ findings: { listFindings: async () => list } });
  deps.digest = { countQuestionsAskedSince: async () => 0 };
  await runAskPass({}, deps);
  assert.deepStrictEqual(deps.calls.notified.map((n) => n.findingId), [402, 401]);
});

test('MONEY FIRST, then serious, then the oldest (the pure order)', () => {
  // eslint-disable-next-line global-require
  const { orderForAsking, whyAsking } = require('../lib/control/priority');
  const old = '2026-09-01T00:00:00Z';
  const fresh = '2026-10-06T00:00:00Z';
  const ordered = orderForAsking([
    { id: 1, severity: 'warning', firstSeenAt: old },
    { id: 2, severity: 'serious', firstSeenAt: fresh },
    { id: 3, severity: 'warning', firstSeenAt: fresh, checkKey: 'home_time.road_bonus_review' },
    { id: 4, severity: 'info', firstSeenAt: old },
  ]);
  assert.deepStrictEqual(ordered.map((f) => f.id), [3, 2, 1, 4]);
  assert.match(whyAsking({ evidence: { reason: '43 days on the road' } }), /^Why I'm asking: 43 days/);
  assert.match(whyAsking({ tier: 'approval' }), /a person has to decide/);
});

test('each kind of question gives its OWN reason, never the generic "pay or records"', () => {
  // Production, 2026-10-07: every approval question gave the same reason,
  // including ones that touch neither pay nor anything a driver would see.
  const asked = Object.keys(WHY_BY_CHECK).map((checkKey) => whyFor({ checkKey, tier: 'approval' }));
  assert.strictEqual(new Set(asked).size, asked.length, 'two kinds of question share a reason');
  for (const why of asked) assert.doesNotMatch(why, /pay or records/);
  // The finding's own reason still wins over the per-kind one.
  assert.match(whyFor({
    checkKey: 'identity.stale_unit_assignment', evidence: { reason: 'board says 310' },
  }), /board says 310/);
});

test('every question says WHY it is being asked', async () => {
  const deps = makeDeps();
  deps.digest = { countQuestionsAskedSince: async () => 0 };
  await runAskPass({}, deps);
  assert.ok(deps.calls.notified[0].lines.some((l) => /^Why I'm asking: /.test(l)));
});
