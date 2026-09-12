'use strict';

/**
 * Where the handler sits in the chain, and that it lets ordinary traffic past.
 *
 * ORDER IS BEHAVIOUR HERE. Registered before the group capture pipeline, an
 * operator's reply would not be recorded as group activity. Registered after
 * the home-time and fuel parsers, a "yes" meant for Wenze would first be read
 * as a driver saying yes to something else. Both are silent failures, so the
 * order is asserted rather than remembered.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { registerControlReplyHandlers } = require('../bot/controlReplyHandlers');

test('registered after the capture pipeline and before every other message handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot', 'bot.js'), 'utf8');
  const capture = source.indexOf('registerGroupCaptureHandlers(bot);');
  const control = source.indexOf('registerControlReplyHandlers(bot);');
  const datatruck = source.indexOf('registerDatatruckPeerHandlers(bot);');

  assert.ok(capture > 0 && control > 0 && datatruck > 0, 'all three are registered');
  assert.ok(control > capture, 'the reply must still be captured as group activity');
  assert.ok(control < datatruck, 'an answer must be consumed before anything else parses it');
});

function fakeBot() {
  const handlers = [];
  return {
    handlers,
    on(event, fn) { handlers.push({ event, fn }); },
  };
}

function ctxFor(message, chat = { id: -100, type: 'supergroup' }) {
  return { message, chat, from: { id: 5, is_bot: false } };
}

test('a message that is not a reply goes straight on to the rest of the pipeline', async () => {
  const bot = fakeBot();
  registerControlReplyHandlers(bot);
  let passedOn = false;
  await bot.handlers[0].fn(ctxFor({ message_id: 1, text: 'on my way' }), () => { passedOn = true; });
  assert.strictEqual(passedOn, true);
});

test('a reply with no text goes on too', async () => {
  const bot = fakeBot();
  registerControlReplyHandlers(bot);
  let passedOn = false;
  await bot.handlers[0].fn(
    ctxFor({ message_id: 1, reply_to_message: { message_id: 2 } }),
    () => { passedOn = true; }
  );
  assert.strictEqual(passedOn, true);
});

test('only the `message` event is claimed', () => {
  const bot = fakeBot();
  registerControlReplyHandlers(bot);
  assert.deepStrictEqual(bot.handlers.map((h) => h.event), ['message']);
});
