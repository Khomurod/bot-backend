/**
 * Handler-level tests for bot/documentIntakeHandlers.js — the Telegram glue.
 * config, db, telegramDocuments and the orchestration service are replaced in
 * the require cache with in-memory fakes so we can assert batching behavior
 * without Telegram/DB: a PDF/photo from a human in a driver group creates a
 * pending batch + file; a bot's own message / non-driver group is ignored; a
 * duplicate file_unique_id is not added twice.
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test';
process.env.BOT_TOKEN ||= 'test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadHandlerWithFakes({ enabled = true, group = { id: 10, group_type: 'driver', active: true } } = {}) {
  const state = { batches: [], files: [], seenUnique: new Set(), scheduled: [], confirmCalls: [] };
  const docsFake = {
    async createBatch(b) { const row = { id: state.batches.length + 1, status: 'collecting', ...b, telegram_chat_id: b.telegramChatId, group_id: b.groupId, telegram_user_id: b.telegramUserId }; state.batches.push(row); return row; },
    async getOrCreateBatchForMediaGroup(b) {
      const found = state.batches.find((x) => x.media_group_id === b.mediaGroupId);
      if (found) return found;
      const row = { id: state.batches.length + 1, status: 'collecting', media_group_id: b.mediaGroupId, telegram_chat_id: b.telegramChatId, group_id: b.groupId, telegram_user_id: b.telegramUserId };
      state.batches.push(row); return row;
    },
    async findOpenBatchForSender({ telegramChatId, telegramUserId }) {
      return state.batches.find((x) => x.telegram_chat_id === telegramChatId && x.telegram_user_id === telegramUserId && x.status === 'collecting' && !x.media_group_id) || null;
    },
    async listBatchFiles(id) { return state.files.filter((f) => f.batch_id === id); },
    async addFileToBatch(id, f) {
      if (f.telegramFileUniqueId && state.seenUnique.has(f.telegramFileUniqueId)) return null;
      if (f.telegramFileUniqueId) state.seenUnique.add(f.telegramFileUniqueId);
      const row = { id: state.files.length + 1, batch_id: id, ...f };
      state.files.push(row); return row;
    },
    async updateBatch() { return null; },
  };
  const configFake = {
    datatruckDocUploadEnabled: enabled,
    datatruckDocUploadDryRun: true,
    datatruckDocIntakeBatchWaitSeconds: 6,
    datatruckDocIntakeMaxFiles: 12,
    datatruckDocIntakeMaxFileMb: 20,
  };
  const dbFake = { async getGroupByTelegramId() { return group; }, async getDriverProfileByGroupId() { return null; } };
  // Group-open buttons: handleConfirmation no longer takes an `authorized` flag.
  // Record every call so tests can assert the clicking user is passed through.
  const intakeFake = {
    async processCollectedBatch() { return { message: null }; },
    async handleConfirmation({ batchId, action, user }) {
      state.confirmCalls.push({ batchId, action, user });
      if (action === 'yes') return { handled: true, reply: '✅ Test mode: feature is working.' };
      if (action === 'no') return { handled: true, reply: '❌ Not uploaded. Marked for review.' };
      if (action === 'disc') return { handled: true, reply: 'Disregarded.' };
      return { handled: true, reply: 'ok' };
    },
  };

  const resolve = (p) => require.resolve(path.resolve(__dirname, p));
  const set = (p, exports) => { require.cache[resolve(p)] = { id: resolve(p), filename: resolve(p), loaded: true, exports }; };
  set('../database/telegramDocuments.js', docsFake);
  set('../config/config.js', configFake);
  set('../database/db.js', dbFake);
  set('../services/documentIntakeService.js', intakeFake);
  // keep real helpers, telegramHtml (safeSend), mileageBonusConstants, routeControlConstants

  const hPath = resolve('../bot/documentIntakeHandlers.js');
  delete require.cache[hPath];
  const handler = require(hPath);
  return { handler, state };
}

function ctxWith(message, chat = { id: -100777, type: 'supergroup' }, from = { id: 5, is_bot: false, username: 'joe' }) {
  return { message: { from, ...message }, chat, from, botInfo: { id: 999 }, telegram: {} };
}

test('a PDF from a human in a driver group creates a pending batch + file', async () => {
  const { handler, state } = loadHandlerWithFakes();
  await handler.handleIntakeMessage(ctxWith({ message_id: 1, document: { file_id: 'F1', file_unique_id: 'U1', mime_type: 'application/pdf', file_name: 'bol.pdf', file_size: 1234 } }));
  assert.equal(state.batches.length, 1);
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].kind, 'pdf');
});

test('a photo message creates a pending batch', async () => {
  const { handler, state } = loadHandlerWithFakes();
  await handler.handleIntakeMessage(ctxWith({ message_id: 2, photo: [{ file_id: 's', file_unique_id: 'us', file_size: 10 }, { file_id: 'b', file_unique_id: 'ub', file_size: 999 }] }));
  assert.equal(state.batches.length, 1);
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].kind, 'image');
});

test('two files of the same media group land in ONE batch', async () => {
  const { handler, state } = loadHandlerWithFakes();
  const mg = '123456789';
  await handler.handleIntakeMessage(ctxWith({ message_id: 3, media_group_id: mg, document: { file_id: 'A', file_unique_id: 'UA', mime_type: 'application/pdf', file_name: 'a.pdf' } }));
  await handler.handleIntakeMessage(ctxWith({ message_id: 4, media_group_id: mg, document: { file_id: 'B', file_unique_id: 'UB', mime_type: 'application/pdf', file_name: 'b.pdf' } }));
  assert.equal(state.batches.length, 1, 'one batch for the album');
  assert.equal(state.files.length, 2, 'both files added');
});

test("the bot's own message is ignored (loop prevention)", async () => {
  const { handler, state } = loadHandlerWithFakes();
  await handler.handleIntakeMessage(ctxWith({ message_id: 5, document: { file_id: 'F', file_unique_id: 'U', mime_type: 'application/pdf' } },
    { id: -100777, type: 'supergroup' }, { id: 999, is_bot: true }));
  assert.equal(state.batches.length, 0);
});

test('a duplicate file_unique_id is not added twice', async () => {
  const { handler, state } = loadHandlerWithFakes();
  const msg = { message_id: 6, document: { file_id: 'F', file_unique_id: 'DUP', mime_type: 'application/pdf', file_name: 'x.pdf' } };
  await handler.handleIntakeMessage(ctxWith(msg));
  await handler.handleIntakeMessage(ctxWith(msg));
  assert.equal(state.files.length, 1);
});

test('a non-driver group is skipped', async () => {
  const { handler, state } = loadHandlerWithFakes({ group: { id: 1, group_type: 'dispatch', active: true } });
  await handler.handleIntakeMessage(ctxWith({ message_id: 7, document: { file_id: 'F', file_unique_id: 'U9', mime_type: 'application/pdf' } }));
  assert.equal(state.batches.length, 0);
});

test('a text-only message (no attachment) does nothing', async () => {
  const { handler, state } = loadHandlerWithFakes();
  await handler.handleIntakeMessage(ctxWith({ message_id: 8, text: 'hello dispatch' }));
  assert.equal(state.batches.length, 0);
});

// Default clicker is a plain, non-admin group member — the whole point is that
// no authorization is required for them.
function callbackCtx(data, from = { id: 4242, username: 'random_driver', first_name: 'Random', last_name: 'Driver' }) {
  const calls = { answered: [], edited: [] };
  const ctx = {
    callbackQuery: { data, message: { chat: { id: -100777 }, message_id: 50 } },
    chat: { id: -100777 },
    from,
    telegram: {},
    async answerCbQuery(text, extra) { calls.answered.push({ text, extra }); },
    async editMessageText(text) { calls.edited.push(text); },
  };
  return { ctx, calls };
}

test('any (non-admin) user clicking Yes → card replaced with the outcome, no unauthorized alert', async () => {
  const { handler } = loadHandlerWithFakes();
  const { ctx, calls } = callbackCtx('dtdoc:yes:1');
  await handler.handleIntakeCallback(ctx);
  assert.equal(calls.edited.length, 1, 'card is replaced with the outcome for anyone');
  assert.match(calls.edited[0], /Test mode/i);
  assert.notEqual(calls.answered[0]?.extra?.show_alert, true, 'no "not authorized" alert');
});

test('any (non-admin) user clicking No → card replaced with the review outcome', async () => {
  const { handler } = loadHandlerWithFakes();
  const { ctx, calls } = callbackCtx('dtdoc:no:1');
  await handler.handleIntakeCallback(ctx);
  assert.equal(calls.edited.length, 1);
  assert.match(calls.edited[0], /Marked for review/i);
});

test('Disregard → card replaced with the outcome', async () => {
  const { handler } = loadHandlerWithFakes();
  const { ctx, calls } = callbackCtx('dtdoc:disc:1');
  await handler.handleIntakeCallback(ctx);
  assert.equal(calls.edited.length, 1);
  assert.match(calls.edited[0], /Disregarded/);
});

test('the handler passes the clicking user through for audit recording', async () => {
  const { handler, state } = loadHandlerWithFakes();
  const { ctx } = callbackCtx('dtdoc:yes:9', { id: 777, username: 'clicky', first_name: 'Click', last_name: 'User' });
  await handler.handleIntakeCallback(ctx);
  assert.equal(state.confirmCalls.length, 1);
  assert.deepEqual(
    { batchId: state.confirmCalls[0].batchId, action: state.confirmCalls[0].action, id: state.confirmCalls[0].user.id, username: state.confirmCalls[0].user.username },
    { batchId: 9, action: 'yes', id: 777, username: 'clicky' }
  );
});

test('a non-dtdoc callback is ignored by the intake handler', async () => {
  const { handler } = loadHandlerWithFakes();
  const { ctx } = callbackCtx('mbonus:paid:1');
  const handled = await handler.handleIntakeCallback(ctx);
  assert.equal(handled, false);
});
