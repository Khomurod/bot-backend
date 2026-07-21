const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  normalizeUsername, normalizeUserId, isAllowedReactionEmoji,
  buildReactionIndexes, matchReactionRule, ALLOWED_REACTION_EMOJIS,
} = require('../services/autoReactionConstants');

// ── Pure constants/helpers ──

test('normalizeUsername strips @, lowercases, and validates', () => {
  assert.equal(normalizeUsername('@Bob_1'), 'bob_1');
  assert.equal(normalizeUsername('  Alice '), 'alice');
  assert.equal(normalizeUsername('has space'), null);
  assert.equal(normalizeUsername('bad!'), null);
  assert.equal(normalizeUsername(''), null);
  assert.equal(normalizeUsername(null), null);
});

test('normalizeUserId accepts only digit strings', () => {
  assert.equal(normalizeUserId(123), '123');
  assert.equal(normalizeUserId('456'), '456');
  assert.equal(normalizeUserId('-1'), null);
  assert.equal(normalizeUserId('abc'), null);
  assert.equal(normalizeUserId(null), null);
});

test('isAllowedReactionEmoji gates on the supported set', () => {
  assert.equal(isAllowedReactionEmoji('👍'), true);
  assert.equal(isAllowedReactionEmoji('🦖'), false);
  assert.equal(isAllowedReactionEmoji(''), false);
  assert.ok(ALLOWED_REACTION_EMOJIS.length > 10);
});

test('matchReactionRule prefers user id over username, skips disabled/invalid', () => {
  const idx = buildReactionIndexes([
    { telegram_user_id: '900', telegram_username: 'driver', emoji: '👍', enabled: true },
    { telegram_user_id: null, telegram_username: 'boss', emoji: '🔥', enabled: true },
    { telegram_user_id: '5', telegram_username: null, emoji: '😡', enabled: false },
    { telegram_user_id: '7', telegram_username: null, emoji: '🦖', enabled: true }, // invalid emoji
  ]);
  assert.equal(matchReactionRule(idx, { id: 900, username: 'someoneelse' }).emoji, '👍');
  assert.equal(matchReactionRule(idx, { id: 1, username: '@BOSS' }).emoji, '🔥');
  assert.equal(matchReactionRule(idx, { id: 5 }), null, 'disabled rule not indexed');
  assert.equal(matchReactionRule(idx, { id: 7 }), null, 'invalid emoji not indexed');
  assert.equal(matchReactionRule(idx, { id: 2, username: 'nobody' }), null);
});

// ── Service applyAutoReaction (DB mocked) ──

function loadService(rows) {
  const servicePath = path.resolve(__dirname, '../services/autoReactionService.js');
  const dbPath = path.resolve(__dirname, '../database/autoReactions.js');
  delete require.cache[servicePath];
  require.cache[dbPath] = {
    exports: { async listEnabledAutoReactionRules() { return rows; } },
  };
  const service = require(servicePath);
  service._reset();
  return service;
}

function makeTelegram() {
  const calls = [];
  return {
    calls,
    async setMessageReaction(chatId, messageId, reaction) { calls.push({ chatId, messageId, reaction }); },
  };
}

test('applyAutoReaction reacts to a matched user by id', async () => {
  const service = loadService([{ telegram_user_id: '900', telegram_username: null, emoji: '👍', enabled: true }]);
  const tg = makeTelegram();
  const ok = await service.applyAutoReaction(tg, {
    message_id: 12, chat: { id: -100 }, from: { id: 900, is_bot: false }, text: 'hi',
  });
  assert.equal(ok, true);
  assert.equal(tg.calls.length, 1);
  assert.deepEqual(tg.calls[0].reaction, [{ type: 'emoji', emoji: '👍' }]);
  assert.equal(tg.calls[0].chatId, -100);
});

test('applyAutoReaction reacts to a matched user by username', async () => {
  const service = loadService([{ telegram_user_id: null, telegram_username: 'boss', emoji: '🔥', enabled: true }]);
  const tg = makeTelegram();
  const ok = await service.applyAutoReaction(tg, {
    message_id: 3, chat: { id: -100 }, from: { id: 42, username: 'Boss', is_bot: false }, text: 'yo',
  });
  assert.equal(ok, true);
  assert.equal(tg.calls[0].reaction[0].emoji, '🔥');
});

test('applyAutoReaction ignores unmatched users, bots, and service messages', async () => {
  const service = loadService([{ telegram_user_id: '900', telegram_username: null, emoji: '👍', enabled: true }]);
  const tg = makeTelegram();
  assert.equal(await service.applyAutoReaction(tg, { message_id: 1, chat: { id: -1 }, from: { id: 111, is_bot: false } }), false);
  assert.equal(await service.applyAutoReaction(tg, { message_id: 2, chat: { id: -1 }, from: { id: 900, is_bot: true } }), false);
  assert.equal(await service.applyAutoReaction(tg, { message_id: 3, chat: { id: -1 }, from: { id: 900, is_bot: false }, new_chat_members: [{}] }), false);
  assert.equal(await service.applyAutoReaction(tg, { message_id: 4, chat: { id: -1 }, from: { id: 900, is_bot: false }, pinned_message: {} }), false);
  assert.equal(tg.calls.length, 0);
});

test('applyAutoReaction never throws when Telegram fails', async () => {
  const service = loadService([{ telegram_user_id: '900', telegram_username: null, emoji: '👍', enabled: true }]);
  const tg = { async setMessageReaction() { throw new Error('not an admin'); } };
  const ok = await service.applyAutoReaction(tg, {
    message_id: 9, chat: { id: -1 }, from: { id: 900, is_bot: false }, text: 'hi',
  });
  assert.equal(ok, false);
});

test('invalidateAutoReactionCache forces a reload so edits apply', async () => {
  let rows = [{ telegram_user_id: '900', telegram_username: null, emoji: '👍', enabled: true }];
  const servicePath = path.resolve(__dirname, '../services/autoReactionService.js');
  const dbPath = path.resolve(__dirname, '../database/autoReactions.js');
  delete require.cache[servicePath];
  require.cache[dbPath] = { exports: { async listEnabledAutoReactionRules() { return rows; } } };
  const service = require(servicePath);
  service._reset();
  const tg = makeTelegram();
  await service.applyAutoReaction(tg, { message_id: 1, chat: { id: -1 }, from: { id: 900, is_bot: false }, text: 'a' });
  assert.equal(tg.calls[0].reaction[0].emoji, '👍');
  rows = [{ telegram_user_id: '900', telegram_username: null, emoji: '🔥', enabled: true }];
  service.invalidateAutoReactionCache();
  await service.applyAutoReaction(tg, { message_id: 2, chat: { id: -1 }, from: { id: 900, is_bot: false }, text: 'b' });
  assert.equal(tg.calls[1].reaction[0].emoji, '🔥', 'reload picked up the edited emoji');
});
