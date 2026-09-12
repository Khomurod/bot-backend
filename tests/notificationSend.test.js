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
  const calls = { enqueued: [], sent: [], delivered: [], failed: [], claimed: [] , discards: [] };
  const discardKeys = new Set();
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
      // Mirrors the real store: a key nobody has seen before moves the counter,
      // and a repeat of one already counted does not. Without this the stub
      // would prove the fix present in `send.js` while saying nothing about
      // whether the count it produces is the right one.
      async recordDiscard(category, reason, noticeKey = null) {
        if (noticeKey) {
          if (discardKeys.has(noticeKey)) return false;
          discardKeys.add(noticeKey);
        }
        calls.discards.push({ category, reason, noticeKey });
        return true;
      },
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

/**
 * THE COUNTER MUST COUNT PROBLEMS, NOT PASSES.
 *
 * Found in production, an hour after the counter shipped. With no destination
 * `notify()` discards at the door — correctly — but it discarded BEFORE
 * building the notice key, so the dedup that exists a few lines further down
 * never ran. The load-lifecycle watch re-checks the same conflicted loads every
 * ten minutes, so `load_lifecycle` reached 95 discards in nine minutes for
 * about 48 distinct loads. Left alone that reads ~48,000 in a week.
 *
 * A number an operator cannot trust is worse than the sentence it replaced:
 * "1,247 notices were thrown away" is only worth acting on if 1,247 is the
 * number of things that went unheard, rather than the number of times the same
 * forty-eight were reconsidered.
 *
 * Delivery is NOT changed by any of this — `noticeSentWithin` still answers
 * only about notices that were queued or sent, so configuring a destination
 * announces everything still true rather than waiting out a window a discard
 * started.
 */
test('the same notice discarded twice is counted ONCE', async () => {
  const { deps, calls } = harness({ defaultChatId: '' });
  const notice = {
    category: 'load_lifecycle', title: 'Unit 123: the board and the truck disagree',
    subjectType: 'load', subjectId: '9001', discriminator: '2026-09-11',
  };
  await notify(notice, deps);
  await notify(notice, deps);
  await notify(notice, deps);
  assert.equal(calls.discards.length, 1,
    'the watch reconsiders the same load every ten minutes; each reconsideration '
    + 'is not a separate thing the operator did not hear about');
});

test('a DIFFERENT load discarded is its own count', async () => {
  const { deps, calls } = harness({ defaultChatId: '' });
  const base = { category: 'load_lifecycle', title: 't', subjectType: 'load', discriminator: '2026-09-11' };
  await notify({ ...base, subjectId: '9001' }, deps);
  await notify({ ...base, subjectId: '9002' }, deps);
  assert.equal(calls.discards.length, 2);
});

test('the same load on a NEW day is a new thing unheard', async () => {
  const { deps, calls } = harness({ defaultChatId: '' });
  const base = { category: 'load_lifecycle', title: 't', subjectType: 'load', subjectId: '9001' };
  await notify({ ...base, discriminator: '2026-09-11' }, deps);
  await notify({ ...base, discriminator: '2026-09-12' }, deps);
  assert.equal(calls.discards.length, 2,
    'the discriminator is what makes THIS event different from the last one, and '
    + 'it is as true of a discard as of a send');
});

test('the notice key travels to the counter, so the dedup is the store\'s to make', async () => {
  const { deps, calls } = harness({ defaultChatId: '' });
  await notify({
    category: 'fuel', title: 't', subjectType: 'truck', subjectId: '305', discriminator: 'low',
  }, deps);
  assert.equal(calls.discards[0].noticeKey, 'fuel:truck:305:low',
    'a counter given only a category cannot tell two trucks apart');
});

// ── a question, and the answer that hangs under it ───────────────────────────

test('a question travels with the notice so a reply can be matched to it', async () => {
  const { deps, calls } = harness();
  await notify({
    ...FUEL,
    category: 'needs_attention',
    findingId: 11,
    question: { findingId: 11, offeredActions: [{ key: 'dismiss' }] },
  }, deps);
  assert.equal(calls.enqueued[0].findingId, 11);
  assert.deepEqual(calls.enqueued[0].question.offeredActions, [{ key: 'dismiss' }]);
});

test('AN ANSWER GOES BACK WHERE IT WAS ASKED, overriding category routing', async () => {
  // The one documented exception. Telegram resolves `reply_to_message_id` only
  // within its own chat, so answering a question in the category's chat would
  // both lose the thread and be refused by Telegram.
  const { deps, calls } = harness({ overrides: { needs_attention: '-100999' } });
  await notify({
    category: 'needs_attention', title: 'Done.',
    subjectType: 'control_reply', subjectId: '-100111:500',
    inReplyTo: { chatId: '-100111', messageId: 500 },
  }, deps);
  assert.equal(calls.sent[0].chatId, '-100111', 'not the category override');
  assert.equal(calls.sent[0].opts.reply_to_message_id, 500);
});

test('a reply target that no longer exists still gets the message through', async () => {
  let attempts = 0;
  const { deps, calls } = harness({
    telegram: {
      async sendMessage(chatId, body, opts) {
        attempts += 1;
        if (opts.reply_to_message_id) throw new Error('Bad Request: message to be replied not found');
        calls.sent.push({ chatId, body, opts });
        return { message_id: 950 };
      },
    },
  });
  const out = await notify({
    category: 'needs_attention', title: 'Done.',
    subjectType: 'control_reply', subjectId: 'x',
    inReplyTo: { chatId: '-100111', messageId: 500 },
  }, deps);
  assert.equal(out.delivered, true);
  assert.equal(attempts, 2, 'tried threaded, then plain');
  assert.equal(calls.sent[0].opts.reply_to_message_id, undefined);
});

test('any other send failure is still a failure — the fallback is not a retry-everything', async () => {
  const { deps, calls } = harness({
    telegram: {
      async sendMessage() { throw new Error('Forbidden: bot was kicked from the group chat'); },
    },
  });
  const out = await notify({
    category: 'needs_attention', title: 'Done.',
    subjectType: 'control_reply', subjectId: 'x',
    inReplyTo: { chatId: '-100111', messageId: 500 },
  }, deps);
  assert.equal(out.delivered, false);
  assert.equal(calls.failed.length, 1);
});
