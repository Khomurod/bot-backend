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
function harness({ recentCount = 0, recentThrows = false, heldCount = 0 } = {}) {
  const calls = { enqueued: [], claimed: [], sent: [], recentAsked: [], heldAsked: [] };
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
    store.countHeldNoticesAbout = async (args) => {
      calls.heldAsked.push(args);
      return heldCount;
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

// ── the hold must not merely move the flood ─────────────────────────────────

test('EACH FURTHER HELD NOTICE WAITS A WINDOW LONGER, so they do not land together',
  async () => {
    // Every held row was dated forward by the same fixed hour, so a hundred
    // notices became three now and ninety-seven together an hour later. The
    // hold moved the flood rather than removing it.
    const none = harness({ recentCount: 3, heldCount: 0 });
    await notify({ ...UNREACHABLE, severity: 'warning' }, none.deps);
    assert.equal(none.calls.enqueued[0].delaySeconds, SUPPRESSION_WINDOW_MINUTES * 60);

    const second = harness({ recentCount: 3, heldCount: 1 });
    await notify({ ...UNREACHABLE, severity: 'warning' }, second.deps);
    assert.equal(second.calls.enqueued[0].delaySeconds, SUPPRESSION_WINDOW_MINUTES * 60 * 2);

    const tenth = harness({ recentCount: 3, heldCount: 9 });
    await notify({ ...UNREACHABLE, severity: 'warning' }, tenth.deps);
    assert.equal(tenth.calls.enqueued[0].delaySeconds, SUPPRESSION_WINDOW_MINUTES * 60 * 10,
      'the tenth thing said about one driver is not urgent enough to arrive with the fourth');
  });

test('a store that cannot count held rows loses the stagger, not the hold', async () => {
  const { deps, calls } = harness({ recentCount: 3 });
  delete deps.store.countHeldNoticesAbout;
  const out = await notify({ ...UNREACHABLE, severity: 'warning' }, deps);
  assert.equal(out.reason, 'held');
  assert.equal(calls.enqueued[0].delaySeconds, SUPPRESSION_WINDOW_MINUTES * 60);
});

test('SUPPRESSION IS SCOPED TO THE CHAT THIS NOTICE IS GOING TO', async () => {
  // Three fuel notices in the fuel team's chat must not hold the first safety
  // notice in a dedicated safety chat — nobody reading that chat saw the burst.
  const { deps, calls } = harness({ recentCount: 0 });
  await notify({ ...UNREACHABLE, severity: 'warning' }, deps);
  assert.equal(calls.recentAsked[0].chatId, '-100111',
    'the destination is already resolved by this point, so scoping costs nothing');
  assert.equal(calls.heldAsked.length, 0,
    'and nothing is counted when nothing is held — the count is only asked to stagger');

  // The stagger count is scoped the same way, so a notice held for one chat's
  // crowd does not queue behind holds belonging to a different chat.
  const crowded = harness({ recentCount: 3, heldCount: 1 });
  await notify({ ...UNREACHABLE, severity: 'warning' }, crowded.deps);
  assert.equal(crowded.calls.heldAsked[0].chatId, '-100111');
});
