/**
 * How urgent a notice is, and what happens when one driver has a bad morning.
 *
 * Both halves were BUILT AND NEVER CALLED. `lib/notifications/priority.js`
 * shipped with nineteen passing tests and zero production callers: every notice
 * left through `notify` at whatever urgency its category was catalogued with,
 * and the module that knew better was reachable only from its own test file.
 * These tests exist against the WIRING, which is the part that was missing.
 *
 * THE TWO RULES THE WIRING MUST NOT BREAK:
 *
 *   A typo cannot raise an alarm. A caller's severity is the more specific
 *   fact and is used; an unrecognised one falls back to the category's, never
 *   to the most alarming reading.
 *
 *   A crowded notice is HELD, NEVER DROPPED. The fourth thing said about one
 *   driver inside an hour is still written down and still delivered — later,
 *   by the sweep, once it is no longer the fourth thing. This application has
 *   already lost 101 alerts to a queue that gave up silently; a suppression
 *   that discarded would be the same failure wearing a better word.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { notify, SUPPRESSION_WINDOW_MINUTES } = require('../services/notifications/send');
const { LEVELS } = require('../lib/notifications/priority');

/**
 * @param {object} opts
 * @param {number|null} opts.recentCount  how many notices about this subject in
 *   the window. `null` means the store has no such read at all — the shape of
 *   every dependency map written before this feature existed.
 */
function harness({ recentCount = 0, recentThrows = false } = {}) {
  const calls = { enqueued: [], claimed: [], sent: [], recentAsked: [] };
  let nextId = 1;
  const store = {
    async recordDiscard() { return true; },
    async enqueueNotification(row) {
      calls.enqueued.push(row);
      return { id: nextId++, ...row };
    },
    async claimNotificationById(id) {
      calls.claimed.push(id);
      return { id, ...calls.enqueued[id - 1] };
    },
    async markNotificationDelivered() {},
    async markNotificationFailed() {},
  };
  if (recentCount !== null) {
    store.listRecentNoticesAbout = async (args) => {
      calls.recentAsked.push(args);
      if (recentThrows) throw new Error('connection terminated');
      return Array.from({ length: recentCount }, () => ({ at: new Date().toISOString() }));
    };
  }
  const deps = {
    settings: {
      async getNotificationSettings() {
        return { enabled: true, defaultChatId: '-100111', categoryChatIds: {} };
      },
    },
    store,
    telegram: {
      async sendMessage(chatId, body) { calls.sent.push({ chatId, body }); return { message_id: 1 }; },
    },
    safeSend: async (fn) => fn(),
  };
  return { deps, calls };
}

/** A truck that cannot reach its stop: 200 miles to go, about 80 in the tank. */
const UNREACHABLE = {
  category: 'fuel',
  title: 'JOHN DOE (Unit 310): may not reach Pilot 442',
  subjectType: 'group',
  subjectId: 7,
  personId: 11,
  facts: { rangeMiles: 80, milesToStation: 200 },
};

// ── urgency comes from the facts, and from the caller who knows the event ────

test('a truck that cannot reach its stop is "now", not the category default', async () => {
  const { deps, calls } = harness();
  const out = await notify({ ...UNREACHABLE, severity: 'serious' }, deps);

  assert.equal(out.priority, LEVELS.NOW);
  assert.equal(calls.enqueued[0].evidence.priority, LEVELS.NOW,
    'and it is recorded with the notice, so a screen can show WHY it was urgent');
  assert.match(calls.sent[0].body, /cannot reach the next stop/,
    'a "now" says what makes it one — that is the justification for the interruption');
});

test('THE SAME CATEGORY, A CALMER TRUCK, AND NO ESCALATION', async () => {
  // The whole argument for a per-event severity: `fuel` is catalogued as a
  // warning, and for this truck that is exactly right.
  const { deps, calls } = harness();
  const out = await notify({
    ...UNREACHABLE,
    severity: 'warning',
    facts: { rangeMiles: 600, milesToStation: 100 },
  }, deps);

  assert.equal(out.priority, LEVELS.WHENEVER);
  assert.doesNotMatch(calls.sent[0].body, /cannot reach/);
});

test('AN UNRECOGNISED SEVERITY FALLS BACK TO THE CATEGORY, NOT TO THE LOUDEST', async () => {
  // A typo must not be a way to page somebody. `fuel` is a warning, so the
  // ceiling is "today" even though the facts on their own say "now".
  const { deps } = harness();
  const out = await notify({ ...UNREACHABLE, severity: 'catastrophic' }, deps);
  assert.equal(out.priority, LEVELS.TODAY,
    'held at the fuel category\'s own ceiling, exactly as if no severity was given');

  const { deps: bare } = harness();
  const noSeverity = await notify(UNREACHABLE, bare);
  assert.equal(noSeverity.priority, LEVELS.TODAY, 'and that is the same answer');
});

test('no facts means no escalation — a notice cannot argue itself urgent', async () => {
  const { deps } = harness();
  const out = await notify({
    category: 'fuel', title: 'something', subjectType: 'group', subjectId: 7, severity: 'serious',
  }, deps);
  assert.equal(out.priority, LEVELS.WHENEVER);
});

// ── one driver, one bad morning ──────────────────────────────────────────────

test('THE FOURTH NOTICE ABOUT ONE DRIVER IS HELD, AND IT IS NOT LOST', async () => {
  const { deps, calls } = harness({ recentCount: 3 });
  const out = await notify({ ...UNREACHABLE, severity: 'warning' }, deps);

  assert.equal(out.reason, 'held');
  assert.equal(out.recorded, true, 'written down');
  assert.equal(out.delivered, false, 'but not sent now');
  assert.equal(calls.enqueued.length, 1, 'the row exists — this is a hold, not a discard');
  assert.equal(calls.enqueued[0].delaySeconds, SUPPRESSION_WINDOW_MINUTES * 60,
    'dated forward by exactly the window that crowded it out, so the sweep delivers it after');
  assert.equal(calls.claimed.length, 0, 'and nothing claimed it for immediate delivery');
  assert.equal(calls.sent.length, 0);
});

test('three is not four — the third still goes out at once', async () => {
  const { deps, calls } = harness({ recentCount: 2 });
  const out = await notify({ ...UNREACHABLE, severity: 'warning' }, deps);
  assert.equal(out.delivered, true);
  assert.equal(calls.enqueued[0].delaySeconds, 0);
});

test('A "NOW" IS NEVER HELD, however crowded the morning', async () => {
  const { deps, calls } = harness({ recentCount: 50 });
  const out = await notify({ ...UNREACHABLE, severity: 'serious' }, deps);
  assert.equal(out.priority, LEVELS.NOW);
  assert.equal(out.delivered, true, 'a thing that gets worse by the hour is worth the interruption');
  assert.equal(calls.enqueued[0].delaySeconds, 0);
});

test('it groups by the person, because the flood is about a human', async () => {
  const { deps, calls } = harness({ recentCount: 0 });
  await notify({ ...UNREACHABLE, severity: 'warning' }, deps);
  assert.equal(calls.recentAsked[0].personId, 11);
  assert.equal(calls.recentAsked[0].withinMinutes, SUPPRESSION_WINDOW_MINUTES);
});

// ── failing open, because a missed notice is the worse failure ───────────────

test('A DEPENDENCY MAP WITHOUT THE NEW READ LOSES THE HOLD, NOT THE NOTICE', async () => {
  // Every caller written before this feature passes a store with no
  // `listRecentNoticesAbout`. Adding a third source to the learning pass once
  // turned that pass off for exactly this reason; it must not happen here.
  const { deps, calls } = harness({ recentCount: null });
  const out = await notify({ ...UNREACHABLE, severity: 'warning' }, deps);
  assert.equal(out.delivered, true);
  assert.equal(calls.sent.length, 1);
});

test('and a read that fails loses the hold, not the notice', async () => {
  const { deps, calls } = harness({ recentCount: 3, recentThrows: true });
  const out = await notify({ ...UNREACHABLE, severity: 'warning' }, deps);
  assert.equal(out.delivered, true, 'saying it twice is a nuisance; not saying it is the failure');
  assert.equal(calls.sent.length, 1);
});
