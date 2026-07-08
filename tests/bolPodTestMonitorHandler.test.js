/**
 * Integration test for the silent monitor wiring in bot/documentIntakeHandlers.js
 * (finalizeBatch). Proves the mode separation:
 *   - monitor ON + upload OFF  → report to the TEST group, NOTHING to the driver group
 *   - monitor OFF + upload OFF  → nothing sent anywhere
 *   - monitor ON + upload ON    → card to the driver group AND report to the test group
 *
 * config / db / telegramDocuments / documentIntakeService / the monitor settings
 * service are faked in the require cache; the REAL report builder runs against a
 * fake telegram that records every send.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test';
process.env.BOT_TOKEN ||= 'test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test';

const TEST_GROUP = '-5289094495';
const DRIVER_CHAT = -100777;

function resolveP(p) { return require.resolve(path.resolve(__dirname, p)); }
function setModule(p, exports) { const abs = resolveP(p); require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }; }

function loadHandler({ uploadEnabled = false, monitorEnabled = true, result } = {}) {
  const defaultResult = {
    action: 'confirm',
    docType: 'pod',
    classification: { type: 'pod', confidence: 0.87, summary: 'delivery signature matched' },
    match: { confidence: 'high', orderId: '123456', loadReference: '9188060', stageHint: 'delivery', distanceToDeliveryMiles: 3.2, reasons: ['Driver is ~3.2 mi from delivery → likely POD.'] },
    batch: { telegram_chat_id: DRIVER_CHAT, group_id: 10, sender_username: 'driverx', telegram_user_id: 55 },
    message: '📄 Card body',
    keyboard: { inline_keyboard: [[{ text: '✅', callback_data: 'dtdoc:yes:1' }]] },
  };

  setModule('../config/config.js', {
    datatruckDocUploadEnabled: uploadEnabled,
    datatruckDocUploadDryRun: true,
    datatruckDocIntakeBatchWaitSeconds: 6,
    datatruckDocIntakeMaxFiles: 12,
    datatruckDocIntakeMaxFileMb: 20,
  });
  setModule('../database/db.js', {
    query: async () => ({ rows: [] }),
    async getGroupByTelegramId() { return { id: 10, group_type: 'driver', active: true }; },
    async getDriverProfileByGroupId() { return { full_name: 'Dilshod Urinov', unit_number: '800', group_name: 'WENZE UNIT #800 DILSHOD' }; },
  });
  setModule('../database/telegramDocuments.js', {
    async listBatchFiles() { return []; },
    async updateBatch() { return null; },
  });
  setModule('../services/documentIntakeService.js', {
    async processCollectedBatch() { return result || defaultResult; },
  });
  setModule('../services/bolPodMonitorSettingsService.js', {
    async getEffectiveSettings() {
      return { enabled: monitorEnabled, testGroupId: TEST_GROUP, sendUnrelated: true, sendUnclear: true, sendFiles: false };
    },
  });

  const hPath = resolveP('../bot/documentIntakeHandlers.js');
  delete require.cache[hPath];
  return require(hPath);
}

function fakeTelegram() {
  const messages = [];
  return {
    messages,
    async sendMessage(chatId, text, extra) { messages.push({ chatId: String(chatId), text, extra }); return { message_id: messages.length }; },
    async sendDocument() { return { message_id: 1 }; },
  };
}

test('monitor ON + upload OFF → report to TEST group, nothing to the driver group', async () => {
  const handler = loadHandler({ uploadEnabled: false, monitorEnabled: true });
  const tg = fakeTelegram();
  await handler.finalizeBatch(tg, 1);
  const toTest = tg.messages.filter((m) => m.chatId === TEST_GROUP);
  const toDriver = tg.messages.filter((m) => m.chatId === String(DRIVER_CHAT));
  assert.equal(toTest.length, 1, 'one report to the test group');
  assert.match(toTest[0].text, /BOL\/POD Test Detection/);
  assert.match(toTest[0].text, /Detected type:<\/b> POD/);
  assert.equal(toDriver.length, 0, 'driver group must receive NOTHING');
});

test('monitor OFF + upload OFF → nothing sent anywhere', async () => {
  const handler = loadHandler({ uploadEnabled: false, monitorEnabled: false });
  const tg = fakeTelegram();
  await handler.finalizeBatch(tg, 1);
  assert.equal(tg.messages.length, 0);
});

test('monitor ON + upload ON → card to driver group AND report to test group', async () => {
  const handler = loadHandler({ uploadEnabled: true, monitorEnabled: true });
  const tg = fakeTelegram();
  await handler.finalizeBatch(tg, 1);
  const toTest = tg.messages.filter((m) => m.chatId === TEST_GROUP);
  const toDriver = tg.messages.filter((m) => m.chatId === String(DRIVER_CHAT));
  assert.equal(toTest.length, 1, 'report still goes to the test group');
  assert.equal(toDriver.length, 1, 'card goes to the driver group when upload pipeline is on');
  assert.match(toDriver[0].text, /Card body/);
});
