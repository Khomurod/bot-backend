/**
 * The one door every operational notice goes through.
 *
 * Each test here is a failure this repository has actually shipped in some
 * form: an alert lost because a destination was blank, an alert repeated
 * because "already sent" lived in memory across a restart that wiped it, and a
 * feature broken because telling somebody about a problem threw inside the code
 * that found it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { notify, runNotificationSweep } = require('../services/notifications/send');

function harness({
  defaultChatId = '-100111', overrides = {}, enabled = true,
  settingsThrows = false, enqueueReturns = undefined, sendThrows = null, telegram = undefined,
} = {}) {
  const calls = { enqueued: [], sent: [], delivered: [], failed: [], claimed: [] };
  let nextId = 1;
  const seen = new Set();

  const deps = {
    settings: {
      async getNotificationSettings() {
        if (settingsThrows) throw new Error('connection refused');
        return { enabled, defaultChatId, categoryChatIds: overrides, repeatAfterHours: 168 };
      },
    },
    store: {
      async enqueueNotification(row) {
        calls.enqueued.push(row);
        if (enqueueReturns !== undefined) return enqueueReturns;
        if (seen.has(row.noticeKey)) return null; // the UNIQUE constraint
        seen.add(row.noticeKey);
        return { id: nextId++, ...row };
      },
      async claimNotificationById(id) {
        calls.claimed.push(id);
        const row = calls.enqueued[id - 1];
        return row ? { id, ...row } : null;
      },
      async claimDueNotifications() { return []; },
      async markNotificationDelivered(id, extra) { calls.delivered.push({ id, ...extra }); },
      async markNotificationFailed(id, error) { calls.failed.push({ id, error }); },
    },
    telegram: telegram === undefined
      ? {
        async sendMessage(chatId, body, opts) {
          if (sendThrows) throw new Error(sendThrows);
          calls.sent.push({ chatId, body, opts });
          return { message_id: 900 + calls.sent.length };
        },
      }
      : telegram,
    safeSend: async (fn) => fn(),
  };
  return { deps, calls };
}

const FUEL = {
  category: 'fuel', title: 'Unit 310 may not reach its fuel stop',
  lines: ['Range about 120 mi, stop 180 mi ahead'],
  subjectType: 'group', subjectId: 7, discriminator: 'stop-442',
};

// ── it arrives ───────────────────────────────────────────────────────────────

test('a notice is recorded and delivered to the default group', async () => {
  const { deps, calls } = harness();
  const out = await notify(FUEL, deps);
  assert.deepEqual({ recorded: out.recorded, delivered: out.delivered }, { recorded: true, delivered: true });
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].chatId, '-100111');
  assert.match(calls.sent[0].body, /Unit 310 may not reach its fuel stop/);
  assert.equal(calls.sent[0].opts.parse_mode, 'HTML');
  assert.equal(calls.delivered[0].telegramMessageId, 901);
});

test('a category override sends to its own group, and records which one', async () => {
  const { deps, calls } = harness({ overrides: { fuel: '-100222' } });
  await notify(FUEL, deps);
  assert.equal(calls.sent[0].chatId, '-100222');
  assert.equal(calls.enqueued[0].routedVia, 'override');
});

test('the destination is stored with the notice, so a later settings change cannot redirect it', async () => {
  const { deps, calls } = harness();
  await notify(FUEL, deps);
  assert.equal(calls.enqueued[0].chatId, '-100111');
  assert.equal(calls.enqueued[0].routedVia, 'default');
});

// ── it is said once ──────────────────────────────────────────────────────────

test('the same event twice is delivered once', async () => {
  const { deps, calls } = harness();
  const first = await notify(FUEL, deps);
  const second = await notify(FUEL, deps);
  assert.equal(first.delivered, true);
  assert.equal(second.recorded, false);
  assert.equal(second.reason, 'already_sent', 'the dedup guarantee working, not a failure');
  assert.equal(calls.sent.length, 1);
});

test('a DIFFERENT event on the same driver is still delivered', async () => {
  const { deps, calls } = harness();
  await notify(FUEL, deps);
  await notify({ ...FUEL, discriminator: 'stop-901', title: 'Unit 310 passed its fuel stop' }, deps);
  assert.equal(calls.sent.length, 2);
});

// ── it is never lost quietly, and never fired stale ──────────────────────────

test('with no destination configured, nothing is recorded and nothing is queued', async () => {
  // Enqueuing here would build a backlog that fires months of stale alerts into
  // a live staff chat the day somebody finally sets a group.
  const { deps, calls } = harness({ defaultChatId: null });
  const out = await notify(FUEL, deps);
  assert.deepEqual(out, { recorded: false, delivered: false, reason: 'no_destination' });
  assert.equal(calls.enqueued.length, 0);
  assert.equal(calls.sent.length, 0);
});

test('switched off means switched off', async () => {
  const { deps, calls } = harness({ enabled: false });
  const out = await notify(FUEL, deps);
  assert.equal(out.reason, 'disabled');
  assert.equal(calls.enqueued.length, 0);
});

test('an unknown category sends nothing rather than falling through to the default', async () => {
  const { deps, calls } = harness();
  const out = await notify({ ...FUEL, category: 'fuell' }, deps);
  assert.equal(out.reason, 'unknown_category');
  assert.equal(calls.sent.length, 0);
});

// ── it never breaks its caller ───────────────────────────────────────────────

test('a Telegram failure is recorded for retry and reported, never thrown', async () => {
  const { deps, calls } = harness({ sendThrows: 'Bad Request: chat not found' });
  const out = await notify(FUEL, deps);
  assert.equal(out.recorded, true, 'the event is durable even though the send failed');
  assert.equal(out.delivered, false);
  assert.equal(calls.failed.length, 1);
  assert.match(calls.failed[0].error, /chat not found/);
});

test('an unreadable settings table does not throw into the feature that found the problem', async () => {
  const { deps } = harness({ settingsThrows: true });
  const out = await notify(FUEL, deps);
  assert.equal(out.reason, 'settings_unavailable');
});

test('no Telegram client is a recorded failure, not a lost notice', async () => {
  const { deps, calls } = harness({ telegram: null });
  const out = await notify(FUEL, deps);
  assert.equal(out.recorded, true);
  assert.equal(out.delivered, false);
  assert.match(calls.failed[0].error, /no telegram client/i);
});

test('losing the claim race counts as success — the sweep owns it now', async () => {
  const { deps, calls } = harness();
  deps.store.claimNotificationById = async () => null;
  const out = await notify(FUEL, deps);
  assert.equal(out.recorded, true);
  assert.equal(out.reason, 'claimed_elsewhere');
  assert.equal(calls.sent.length, 0);
});

// ── the sweep ────────────────────────────────────────────────────────────────

test('the sweep delivers what the immediate attempt could not', async () => {
  const { deps, calls } = harness();
  deps.store.claimDueNotifications = async () => ([
    { id: 5, chatId: '-100111', body: 'first' },
    { id: 6, chatId: '-100111', body: 'second' },
  ]);
  const out = await runNotificationSweep({}, deps);
  assert.deepEqual(out, { claimed: 2, delivered: 2 });
  assert.deepEqual(calls.sent.map((s) => s.body), ['first', 'second']);
});

test('one bad notice in a sweep does not stop the rest', async () => {
  const { deps, calls } = harness();
  let n = 0;
  deps.telegram.sendMessage = async () => {
    n += 1;
    if (n === 1) throw new Error('chat not found');
    return { message_id: 1 };
  };
  deps.store.claimDueNotifications = async () => ([
    { id: 5, chatId: '-100111', body: 'bad' },
    { id: 6, chatId: '-100111', body: 'good' },
  ]);
  const out = await runNotificationSweep({}, deps);
  assert.deepEqual(out, { claimed: 2, delivered: 1 });
  assert.equal(calls.failed.length, 1);
});

test('a sweep that cannot reach the database reports zero rather than throwing', async () => {
  const { deps } = harness();
  deps.store.claimDueNotifications = async () => { throw new Error('connection refused'); };
  assert.deepEqual(await runNotificationSweep({}, deps), { claimed: 0, delivered: 0 });
});
