'use strict';

/**
 * bot/handlers/truckPhotoHandlers.js — an OBSERVER: it always calls next(),
 * it cannot throw at the bot, and it sits right after Safety Approvals and
 * before the control channel, so every handler after it sees driver messages
 * exactly as before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let captured = [];
let noticed = [];
let failCapture = false;
stub('services/truckPhotos/capture.js', {
  captureTruckPhoto: async (message) => {
    if (failCapture) throw new Error('should be impossible, but');
    captured.push(message.message_id);
    return { captured: true };
  },
});
stub('services/truckPhotos/triggerHandler.js', {
  noticeTruckPhotoTrigger: async (message, ctx) => { noticed.push([message.message_id, ctx.telegram]); return {}; },
});

const { registerTruckPhotoHandlers } = require('../bot/handlers/truckPhotoHandlers');

function fakeBot() {
  const handlers = [];
  return { handlers, on(event, fn) { handlers.push({ event, fn }); } };
}

test('only `message` is observed, and next() is always called', async () => {
  const bot = fakeBot();
  registerTruckPhotoHandlers(bot);
  assert.deepEqual(bot.handlers.map((h) => h.event), ['message']);
  captured = []; noticed = [];
  const telegram = { id: 'tg' };
  let passed = 0;
  await bot.handlers[0].fn({ message: { message_id: 7 }, telegram }, () => { passed += 1; });
  assert.equal(passed, 1);
  assert.deepEqual(captured, [7], 'the photo is remembered before the word is looked at');
  assert.deepEqual(noticed, [[7, telegram]]);
});

test('a failure inside never stops the message reaching the next handler', async () => {
  const bot = fakeBot();
  registerTruckPhotoHandlers(bot);
  failCapture = true;
  let passed = false;
  await bot.handlers[0].fn({ message: { message_id: 8 }, telegram: {} }, () => { passed = true; });
  failCapture = false;
  assert.equal(passed, true);
});

test('registered right after Safety Approvals and before the control channel', () => {
  const source = fs.readFileSync(path.join(ROOT, 'bot', 'bot.js'), 'utf8');
  const capture = source.indexOf('registerGroupCaptureHandlers(bot);');
  const safety = source.indexOf('registerSafetyApprovalHandlers(bot);');
  const trucks = source.indexOf('registerTruckPhotoHandlers(bot);');
  const control = source.indexOf('registerControlReplyHandlers(bot);');
  assert.ok(capture > 0 && safety > capture && trucks > safety && control > trucks);
});
