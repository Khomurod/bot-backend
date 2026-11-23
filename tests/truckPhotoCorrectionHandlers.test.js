'use strict';

/**
 * bot/handlers/truckPhotoCorrectionHandlers.js — the thin wiring: a reply in
 * the bot's private chat that IS a correction is consumed (the feedback prompt
 * never sees it), anything else goes on; a driver-group reply that tags the
 * bot is taken up and ALWAYS goes on; the profile buttons are answered.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerTruckPhotoCorrectionHandlers } = require('../bot/handlers/truckPhotoCorrectionHandlers');
const { withoutBotMention, mentionsBot } = require('../lib/telegram/botMention');

function fakeBot() {
  const bot = { handlers: [], actions: [] };
  bot.on = (event, fn) => bot.handlers.push(fn);
  bot.action = (pattern, fn) => bot.actions.push({ pattern, fn });
  return bot;
}
const BOT = { id: 999, username: 'wenzefeedback_bot' };
const ctxFor = (message, chat) => ({
  message, chat, from: message.from, botInfo: BOT, telegram: {},
});

test('private: a correction is consumed; a reply that is not one goes on', async () => {
  const taken = [];
  const bot = fakeBot();
  registerTruckPhotoCorrectionHandlers(bot, { take: async (req) => { taken.push(req); return { handled: req.replyToMessageId === 901 }; } });
  const [handler] = bot.handlers;
  let next = 0;
  const msg = (replyTo) => ({ message_id: 50, text: 'truck 027', from: { id: 777000, first_name: 'Tom' }, reply_to_message: { message_id: replyTo } });
  await handler(ctxFor(msg(901), { id: 777000, type: 'private' }), () => { next += 1; });
  assert.equal(next, 0, 'consumed');
  await handler(ctxFor(msg(5), { id: 777000, type: 'private' }), () => { next += 1; });
  assert.equal(next, 1, 'not ours: goes on to the feedback prompt');
  assert.equal(taken[0].source, 'private');
});

test('group: a tagged reply is taken up without its tag, and the message always goes on; untagged is not taken', async () => {
  const taken = [];
  const bot = fakeBot();
  registerTruckPhotoCorrectionHandlers(bot, { take: async (req) => { taken.push(req); return { handled: true }; } });
  const [handler] = bot.handlers;
  let next = 0;
  const text = '@WenzeFeedback_Bot truck is 027';
  const tagged = {
    message_id: 120, text, from: { id: 4444, first_name: 'Kim' }, reply_to_message: { message_id: 100 },
    entities: [{ type: 'mention', offset: 0, length: 18 }],
  };
  await handler(ctxFor(tagged, { id: -100555, type: 'supergroup' }), () => { next += 1; });
  await handler(ctxFor({ ...tagged, entities: [] }, { id: -100555, type: 'supergroup' }), () => { next += 1; });
  assert.equal(next, 2, 'the group sees every message as before');
  assert.equal(taken.length, 1);
  assert.equal(taken[0].text, 'truck is 027');
  assert.equal(taken[0].replyToMessageId, 100);
  assert.equal(mentionsBot(tagged, BOT), true);
  assert.equal(withoutBotMention({ text: 'ok @x', entities: [] }, BOT), 'ok @x');
});

test('a profile button: answered, and the question replaced by what happened', async () => {
  const bot = fakeBot();
  registerTruckPhotoCorrectionHandlers(bot, { press: async () => ({ text: 'Done.', edit: 'Done: the profile says unit 027 now.' }) });
  const [{ pattern, fn }] = bot.actions;
  assert.ok(pattern.test('tpu:y:9:088:027'));
  const said = [];
  await fn({
    callbackQuery: { data: 'tpu:y:9:088:027' }, from: { id: 777000 },
    editMessageText: async (t) => said.push(['edit', t]), answerCbQuery: async (t) => said.push(['answer', t]),
  });
  assert.deepEqual(said, [['edit', 'Done: the profile says unit 027 now.'], ['answer', 'Done.']]);
});
