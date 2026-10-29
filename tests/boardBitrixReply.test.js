'use strict';

/**
 * Board ↔ Bitrix: the owner's reply under a question. Only an operator is
 * listened to; "done" re-checks Bitrix and confirms or says what still
 * differs; "skip" comes back tomorrow; a redelivered reply does nothing; and
 * the handler sits after the learning questions' and lets everything else by.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { handleBoardBitrixReply } = require('../services/boardBitrix/reply');
const { registerBoardBitrixReplyHandlers } = require('../bot/handlers/boardBitrixReplyHandlers');

const OWNER = 2117922421;
const DETAILS = { kind: 'truck_differs', board: { name: 'A B', truck: '310' }, deal: { id: 321, title: 'A B', stageId: 'C3:UC_XZ955I', truckTitle: 'Trucks #311', truckNumber: '311' } };
const reply = (over = {}) => ({
  chatId: -100, chatType: 'supergroup', messageId: 900, repliedToMessageId: 77, text: 'done', telegramUserId: OWNER, fromIsBot: false, ...over,
});

function fakes({ state = 'asked', after = 'resolved', claim = true, recheck = { discrepancies: 0 }, notice = { subjectType: 'board_bitrix_question', subjectId: '7' } } = {}) {
  const calls = { said: [], asked: 0, rechecks: [], snoozed: [] };
  let reads = 0;
  const deps = {
    notices: { findNoticeByTelegramMessage: async () => notice },
    operators: { isControlOperator: async (id) => id === OWNER },
    store: {
      getDiscrepancy: async () => {
        reads += 1;
        return { id: 7, state: reads === 1 ? state : after, details: DETAILS };
      },
      claimReply: async () => (claim ? { id: 7 } : null),
      snooze: async (id, hours) => { calls.snoozed.push(hours); return { id }; },
    },
    recheck: async (id) => { calls.rechecks.push(id); return recheck; },
    askNext: async () => { calls.asked += 1; return { asked: true }; },
    say: async (args) => { calls.said.push(args); },
    portalOrigin: async () => null,
  };
  return { deps, calls };
}

test('"done": Bitrix is re-read, the fix confirmed under the owner\'s message, then the next question', async () => {
  const { deps, calls } = fakes();
  const out = await handleBoardBitrixReply(reply(), deps);
  assert.deepEqual(out, { handled: true, outcome: 'confirmed' });
  assert.deepEqual(calls.rechecks, [7]);
  assert.match(calls.said[0].text, /Confirmed/);
  assert.equal(calls.said[0].messageId, 900, 'under the owner\'s own reply');
  assert.equal(calls.asked, 1);
});

test('"done" but still different: says what is still different, asks nothing new', async () => {
  const { deps, calls } = fakes({ after: 'asked' });
  const out = await handleBoardBitrixReply(reply({ text: 'сделал' }), deps);
  assert.equal(out.outcome, 'still_different');
  assert.match(calls.said[0].text, /Still different/);
  assert.ok(calls.said[0].lines.some((l) => l.includes('truck 310')));
  assert.equal(calls.asked, 0);
});

test('"done" while the timer\'s pass was already fixing it: its "Fixed" line stands, no second confirmation, nothing asked twice', async () => {
  const { deps, calls } = fakes();
  let reads = 0;
  deps.store.getDiscrepancy = async () => { reads += 1; return { id: 7, state: reads === 1 ? 'asked' : 'resolved', resolvedHow: reads === 1 ? null : 'seen_fixed', details: DETAILS }; };
  const out = await handleBoardBitrixReply(reply(), deps);
  assert.equal(out.outcome, 'fixed_meanwhile');
  assert.equal(calls.said.length + calls.asked, 0);
});

test('"done" when Bitrix cannot be read: says so, keeps the question', async () => {
  const { deps, calls } = fakes({ recheck: { error: 'Bitrix could not be read: timeout' } });
  const out = await handleBoardBitrixReply(reply(), deps);
  assert.equal(out.outcome, 'recheck_failed');
  assert.match(calls.said[0].text, /could not check Bitrix/);
  assert.equal(calls.asked, 0);
});

test('"skip" comes back tomorrow and the next question goes out', async () => {
  const { deps, calls } = fakes();
  const out = await handleBoardBitrixReply(reply({ text: 'skip' }), deps);
  assert.equal(out.outcome, 'skipped');
  assert.deepEqual(calls.snoozed, [24]);
  assert.equal(calls.rechecks.length, 0);
  assert.equal(calls.asked, 1);
});

test('anything else: one line on what to type; nothing re-read, nothing moved', async () => {
  const { deps, calls } = fakes();
  const out = await handleBoardBitrixReply(reply({ text: 'who is this?' }), deps);
  assert.equal(out.outcome, 'unclear');
  assert.match(calls.said[0].text, /reply "done"/);
  assert.equal(calls.rechecks.length + calls.snoozed.length + calls.asked, 0);
});

test('BEING IN THE GROUP IS NOT PERMISSION: a stranger is consumed, never answered or acted on', async () => {
  const { deps, calls } = fakes();
  const out = await handleBoardBitrixReply(reply({ telegramUserId: 555 }), deps);
  assert.deepEqual(out, { handled: true, outcome: 'ignored_unauthorised' });
  assert.equal(calls.said.length + calls.rechecks.length, 0);
});

test('a redelivered reply does nothing; a question already fixed or not out is said so', async () => {
  const dup = fakes({ claim: false });
  assert.equal((await handleBoardBitrixReply(reply(), dup.deps)).outcome, 'duplicate');
  assert.equal(dup.calls.said.length + dup.calls.rechecks.length, 0);
  assert.equal((await handleBoardBitrixReply(reply(), fakes({ state: 'resolved' }).deps)).outcome, 'already_fixed');
  assert.equal((await handleBoardBitrixReply(reply(), fakes({ state: 'open' }).deps)).outcome, 'not_open');
});

test('not ours: not a group, from a bot, not a reply, or a reply to some other notice — passed on', async () => {
  const { deps } = fakes();
  for (const over of [{ chatType: 'private' }, { fromIsBot: true }, { repliedToMessageId: null }, { text: '  ' }]) {
    assert.equal((await handleBoardBitrixReply(reply(over), deps)).handled, false, JSON.stringify(over));
  }
  const other = fakes({ notice: { subjectType: 'ai_learning_question', subjectId: '7' } });
  assert.equal((await handleBoardBitrixReply(reply(), other.deps)).handled, false);
});

test('registered right after the learning questions\' handler and before the driver handlers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot', 'bot.js'), 'utf8');
  const lesson = source.indexOf('registerLessonReplyHandlers(bot);');
  const ours = source.indexOf('registerBoardBitrixReplyHandlers(bot);');
  const datatruck = source.indexOf('registerDatatruckPeerHandlers(bot);');
  assert.ok(lesson > 0 && ours > lesson && ours < datatruck);
});

test('the handler lets every message that is not one of our answers through', async () => {
  const handlers = [];
  registerBoardBitrixReplyHandlers({ on: (event, fn) => handlers.push({ event, fn }) }, { handle: async () => ({ handled: false }) });
  let passed = 0;
  const ctx = (message) => ({ message, chat: { id: -100, type: 'supergroup' }, from: { id: 1, is_bot: false } });
  await handlers[0].fn(ctx({ message_id: 1, text: 'on my way' }), () => { passed += 1; });
  await handlers[0].fn(ctx({ message_id: 2, text: 'done', reply_to_message: { message_id: 1 } }), () => { passed += 1; });
  assert.equal(passed, 2);
  const consumed = [];
  registerBoardBitrixReplyHandlers({ on: (event, fn) => consumed.push(fn) }, { handle: async () => ({ handled: true }) });
  let nextCalled = false;
  await consumed[0](ctx({ message_id: 3, text: 'done', reply_to_message: { message_id: 1 } }), () => { nextCalled = true; });
  assert.equal(nextCalled, false);
});
