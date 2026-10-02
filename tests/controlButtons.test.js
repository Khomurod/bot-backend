'use strict';

/**
 * The Yes / No / Later buttons.
 *
 * What each test protects, in the order a tap meets it:
 *   a button names a notice and a letter, never an operation;
 *   a tap means exactly what typing the word means;
 *   a button is refused on any message but its own;
 *   a stranger tapping first cannot stop the owner answering;
 *   a double tap applies nothing twice;
 *   "No" still asks why, and the follow-up hangs under the question.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  keyboardFor, parseButton, wordFor, PATTERN,
} = require('../lib/control/buttons');
const { parseIntent } = require('../lib/control/intent');
const { offeredActionsFor } = require('../lib/control/askable');
const { handleControlButton } = require('../services/control/buttonHandler');

const ALL = offeredActionsFor({ hasAction: true });

// ── the keyboard ────────────────────────────────────────────────────────────

test('one button per offered answer, in the order offered', () => {
  const kb = keyboardFor(42, ALL);
  const row = kb.inline_keyboard[0];
  assert.deepStrictEqual(row.map((b) => b.callback_data), ['ctl:42:a', 'ctl:42:d', 'ctl:42:s']);
  assert.deepStrictEqual(row.map((b) => b.text), ['✅ Yes', '❌ No', '⏰ Later']);
});

test('nothing to apply means no Yes button', () => {
  const row = keyboardFor(42, offeredActionsFor({ hasAction: false })).inline_keyboard[0];
  assert.deepStrictEqual(row.map((b) => b.callback_data), ['ctl:42:d', 'ctl:42:s']);
});

test('no offered answers, or no notice id, means no keyboard at all', () => {
  assert.strictEqual(keyboardFor(42, []), null);
  assert.strictEqual(keyboardFor(42, [{ key: 'engineering_request' }]), null);
  assert.strictEqual(keyboardFor(null, ALL), null);
  assert.strictEqual(keyboardFor(0, ALL), null);
});

test('a button never names an action key and fits Telegram\'s 64 bytes', () => {
  const row = keyboardFor(999999999999, ALL).inline_keyboard[0];
  for (const b of row) {
    assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    assert.ok(!/approve|dismiss|snooze/.test(b.callback_data + b.text), b.callback_data);
  }
});

test('a tap is read back, and anything else is not ours', () => {
  assert.deepStrictEqual(parseButton('ctl:42:a'), { noticeId: 42, action: 'approve' });
  assert.deepStrictEqual(parseButton('ctl:42:d'), { noticeId: 42, action: 'dismiss' });
  assert.deepStrictEqual(parseButton('ctl:42:s'), { noticeId: 42, action: 'snooze' });
  for (const other of ['mbonus:paid:3', 'ctl:42:x', 'ctl:0:a', 'ctl:-4:a', 'ctl:42:a:1', '', null]) {
    assert.strictEqual(parseButton(other), null, String(other));
  }
  assert.ok(PATTERN.test('ctl:7:s'));
});

test('a tap means exactly what typing its word means', () => {
  for (const action of ['approve', 'dismiss', 'snooze']) {
    const intent = parseIntent(wordFor(action), { offered: ALL });
    assert.strictEqual(intent.action, action);
  }
  // "Later" is the same week a typed "later" is.
  assert.strictEqual(parseIntent(wordFor('snooze'), { offered: ALL }).snoozeHours, 24 * 7);
  // "No" carries no reason, so the owner is still asked why.
  assert.strictEqual(parseIntent(wordFor('dismiss'), { offered: ALL }).reason || null, null);
});

// ── the handler ─────────────────────────────────────────────────────────────

/** A replies store with the real UNIQUE (chat_id, reply_message_id). */
function repliesStore(calls) {
  const taken = new Set();
  return {
    recordReply: async (row) => {
      const key = `${row.chatId}|${row.replyMessageId}`;
      calls.recorded.push(row);
      if (taken.has(key)) return null;
      taken.add(key);
      return { id: calls.recorded.length, ...row };
    },
    finaliseReply: async (id, patch) => { calls.finalised.push({ id, ...patch }); return { id }; },
  };
}

function makeDeps(overrides = {}) {
  const calls = {
    lookups: 0, recorded: [], finalised: [], acks: [], executed: [], answered: [], notified: [],
  };
  const deps = {
    settings: { getControlSettings: async () => ({ enabled: true, clarifyLimit: 1 }) },
    operators: { isControlOperator: async (id) => String(id) === '2117922421' },
    replies: repliesStore(calls),
    notices: {
      findNoticeByTelegramMessage: async () => {
        calls.lookups += 1;
        return { id: 3, findingId: 11, question: { findingId: 11, offeredActions: ALL } };
      },
      markNoticeAnswered: async (id, replyId) => { calls.answered.push([id, replyId]); return true; },
    },
    findings: {
      getFindingById: async () => ({ id: 11, status: 'open', checkKey: 'identity.stale_unit_assignment' }),
    },
    parseIntent,
    readReplyWithAi: async () => { throw new Error('a button must never reach a model'); },
    notify: async (n) => { calls.notified.push(n); return { recorded: true }; },
    rememberAnswerFor: async () => ({ id: 9 }),
    fileRequest: async () => { throw new Error('a button is never an engineering request'); },
    executeOffered: async (args) => {
      calls.executed.push(args);
      const outcome = { approve: 'applied', dismiss: 'dismissed', snooze: 'snoozed' }[args.intent.action];
      return { outcome, message: `did ${args.intent.action}`, correctionId: 55, decisionId: 66 };
    },
    ack: async (a) => { calls.acks.push(a); },
  };
  return { ...deps, ...overrides, calls };
}

const OWNER = '2117922421';
const TAP = {
  data: 'ctl:3:a', chatId: '-100123', chatType: 'supergroup', messageId: 400,
  telegramUserId: OWNER, fromIsBot: false,
};

test('another feature\'s button is not ours, and costs no database read', async () => {
  const deps = makeDeps();
  const got = await handleControlButton({ ...TAP, data: 'mbonus:paid:3' }, deps);
  assert.strictEqual(got.handled, false);
  assert.strictEqual(deps.calls.lookups, 0);
});

test('a button whose notice id is not the message it sits on is refused', async () => {
  const deps = makeDeps();
  const got = await handleControlButton({ ...TAP, data: 'ctl:99:a' }, deps);
  assert.strictEqual(got.outcome, 'refused');
  assert.strictEqual(deps.calls.recorded.length, 0);
  assert.strictEqual(deps.calls.executed.length, 0);
});

test('outside a group the button does nothing', async () => {
  const deps = makeDeps();
  const got = await handleControlButton({ ...TAP, chatType: 'private' }, deps);
  assert.strictEqual(got.outcome, 'refused');
  assert.strictEqual(deps.calls.lookups, 0);
});

test('Yes applies the offered change, once, and the buttons come off', async () => {
  const deps = makeDeps();
  const got = await handleControlButton(TAP, deps);
  assert.strictEqual(got.outcome, 'applied');
  assert.strictEqual(got.clear, true);
  assert.strictEqual(deps.calls.executed.length, 1);
  assert.strictEqual(deps.calls.executed[0].intent.action, 'approve');
  assert.strictEqual(deps.calls.executed[0].telegramUserId, OWNER);
  // Claimed under the question's own message id.
  assert.strictEqual(deps.calls.recorded[0].replyMessageId, 400);
  assert.strictEqual(deps.calls.recorded[0].rawText, 'yes (button)');
  // The acknowledgement hangs under the question.
  assert.strictEqual(deps.calls.acks[0].inReplyToMessageId, 400);
  assert.deepStrictEqual(deps.calls.answered[0], [3, 1]);
  assert.match(got.toast, /did approve/);
});

test('a double tap applies nothing twice', async () => {
  const deps = makeDeps();
  await handleControlButton(TAP, deps);
  const second = await handleControlButton(TAP, deps);
  assert.strictEqual(second.outcome, 'redelivery');
  assert.match(second.toast, /Already answered/);
  assert.strictEqual(deps.calls.executed.length, 1);
});

test('a stranger tapping first is recorded, obeyed by nothing, and does not block the owner', async () => {
  const deps = makeDeps();
  const stranger = await handleControlButton({ ...TAP, telegramUserId: '555' }, deps);
  assert.strictEqual(stranger.outcome, 'ignored_unauthorised');
  assert.strictEqual(stranger.toast, '', 'a stranger is told nothing');
  assert.strictEqual(stranger.clear, undefined, 'the buttons stay for the owner');
  assert.strictEqual(deps.calls.recorded[0].replyMessageId, -400);
  assert.strictEqual(deps.calls.recorded[0].outcome, 'ignored_unauthorised');
  assert.strictEqual(deps.calls.executed.length, 0);
  assert.strictEqual(deps.calls.acks.length, 0);

  const owner = await handleControlButton(TAP, deps);
  assert.strictEqual(owner.outcome, 'applied');
  assert.strictEqual(deps.calls.executed.length, 1);
});

test('No still asks why, under the question, with buttons of its own', async () => {
  const deps = makeDeps();
  const got = await handleControlButton({ ...TAP, data: 'ctl:3:d' }, deps);
  assert.strictEqual(got.outcome, 'clarified');
  assert.strictEqual(got.clear, true);
  assert.strictEqual(deps.calls.executed.length, 0, 'nothing is dismissed without a reason yet');
  const followUp = deps.calls.notified[0];
  assert.deepStrictEqual(followUp.inReplyTo, { chatId: '-100123', messageId: 400 });
  assert.deepStrictEqual(followUp.question.pending, { action: 'dismiss' });
  assert.deepStrictEqual(followUp.question.offeredActions, ALL);
  assert.strictEqual(followUp.clarifyRound, 1);
});

test('No on the "why?" follow-up closes it with the default reason rather than asking again', async () => {
  const deps = makeDeps({
    notices: {
      findNoticeByTelegramMessage: async () => ({
        id: 4, findingId: 11, parentNoticeId: 3, clarifyRound: 1,
        question: { findingId: 11, offeredActions: ALL, pending: { action: 'dismiss' } },
      }),
      markNoticeAnswered: async () => true,
    },
  });
  const got = await handleControlButton({ ...TAP, data: 'ctl:4:d', messageId: 401 }, deps);
  assert.strictEqual(got.outcome, 'dismissed');
  assert.strictEqual(deps.calls.executed[0].intent.action, 'dismiss');
});

test('Later puts it aside for a week', async () => {
  const deps = makeDeps();
  const got = await handleControlButton({ ...TAP, data: 'ctl:3:s' }, deps);
  assert.strictEqual(got.outcome, 'snoozed');
  assert.strictEqual(deps.calls.executed[0].intent.snoozeHours, 24 * 7);
});

test('a button for an answer the question did not offer is refused', async () => {
  const deps = makeDeps({
    notices: {
      findNoticeByTelegramMessage: async () => ({
        id: 3, findingId: 11, question: { offeredActions: offeredActionsFor({ hasAction: false }) },
      }),
      markNoticeAnswered: async () => true,
    },
  });
  const got = await handleControlButton(TAP, deps);
  assert.strictEqual(got.outcome, 'refused');
  assert.strictEqual(deps.calls.recorded.length, 0);
});

test('switched off, a tap is silent and claims nothing', async () => {
  const deps = makeDeps({ settings: { getControlSettings: async () => ({ enabled: false }) } });
  const got = await handleControlButton(TAP, deps);
  assert.strictEqual(got.outcome, 'ignored_disabled');
  assert.strictEqual(got.toast, '');
  assert.strictEqual(deps.calls.recorded.length, 0);
});

test('a finding already fixed in the admin is not fixed again', async () => {
  const deps = makeDeps({
    findings: { getFindingById: async () => ({ id: 11, status: 'applied' }) },
  });
  const got = await handleControlButton(TAP, deps);
  assert.strictEqual(got.outcome, 'no_op');
  assert.match(got.toast, /Already applied/);
  assert.strictEqual(deps.calls.executed.length, 0);
});

test('a failure inside is answered, never thrown', async () => {
  const deps = makeDeps({
    settings: { getControlSettings: async () => { throw new Error('db down'); } },
  });
  const got = await handleControlButton(TAP, deps);
  assert.strictEqual(got.handled, true);
  assert.strictEqual(got.outcome, 'failed');
  assert.match(got.toast, /reply to the question in words/i);
});
