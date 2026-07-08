/**
 * Unit tests for services/driverMention.js — how Route Control addresses the
 * driver of a group: Telegram user id > username > plain name, always HTML-safe,
 * and never sourced from ambient group chatter (so a dispatcher can't be tagged).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  buildDriverMention, normalizeTelegramUserId, escapeHtml, resolveDriverMentionForGroup,
} = require('../services/driverMention');

test('mention by Telegram user id → tg://user link, high confidence', () => {
  const m = buildDriverMention({ telegramUserId: '12345', username: 'joe', displayName: 'Joe Driver' });
  assert.equal(m.mentionHtml, '<a href="tg://user?id=12345">Joe Driver</a>');
  assert.equal(m.source, 'telegram_user_id');
  assert.equal(m.confidence, 'high');
  assert.equal(m.telegramUserId, '12345');
});

test('mention by username when no id → @username, medium confidence', () => {
  const m = buildDriverMention({ username: '@Joe_D', displayName: 'Joe' });
  assert.equal(m.mentionHtml, '@joe_d');
  assert.equal(m.source, 'telegram_username');
  assert.equal(m.confidence, 'medium');
});

test('plain name fallback when no Telegram account → escaped name, low confidence', () => {
  const m = buildDriverMention({ displayName: 'Ali & Sons <LLC>' });
  assert.equal(m.mentionHtml, 'Ali &amp; Sons &lt;LLC&gt;');
  assert.equal(m.telegramUserId, null);
  assert.equal(m.username, null);
  assert.equal(m.confidence, 'low');
});

test('the display name inside a tg://user mention is HTML-escaped', () => {
  const m = buildDriverMention({ telegramUserId: 7, displayName: 'A <b>x</b> & c' });
  assert.equal(m.mentionHtml, '<a href="tg://user?id=7">A &lt;b&gt;x&lt;/b&gt; &amp; c</a>');
});

test('falls back to the group name, then to "driver"', () => {
  assert.equal(buildDriverMention({ groupName: 'WENZE UNIT 800' }).displayName, 'WENZE UNIT 800');
  assert.equal(buildDriverMention({}).displayName, 'driver');
});

test('normalizeTelegramUserId accepts positive ints only', () => {
  assert.equal(normalizeTelegramUserId('42'), '42');
  assert.equal(normalizeTelegramUserId(42), '42');
  assert.equal(normalizeTelegramUserId('0'), null);
  assert.equal(normalizeTelegramUserId('-5'), null);
  assert.equal(normalizeTelegramUserId('abc'), null);
  assert.equal(normalizeTelegramUserId(null), null);
});

test('escapeHtml handles the three dangerous characters', () => {
  assert.equal(escapeHtml('<a> & </a>'), '&lt;a&gt; &amp; &lt;/a&gt;');
});

// ── resolveDriverMentionForGroup (DB-backed, stubbed) ──

function loadResolver(dbMock) {
  const modPath = path.resolve(__dirname, '../services/driverMention.js');
  delete require.cache[modPath];
  const mod = require(modPath);
  return (groupId) => mod.resolveDriverMentionForGroup(groupId, { db: dbMock });
}

test('resolveDriverMentionForGroup prefers the driver profile Telegram id', async () => {
  const resolve = loadResolver({
    async getDriverProfileByGroupId() {
      return { telegram_user_id: 555, telegram_username: 'jd', full_name: 'Jane Driver', group_name: 'G' };
    },
  });
  const m = await resolve(7);
  assert.equal(m.source, 'telegram_user_id');
  assert.equal(m.mentionHtml, '<a href="tg://user?id=555">Jane Driver</a>');
});

test('resolveDriverMentionForGroup uses username when the profile has no id', async () => {
  const resolve = loadResolver({
    async getDriverProfileByGroupId() {
      return { telegram_user_id: null, telegram_username: 'jd', full_name: 'Jane Driver', group_name: 'G' };
    },
  });
  const m = await resolve(7);
  assert.equal(m.source, 'telegram_username');
  assert.equal(m.mentionHtml, '@jd');
});

test('resolveDriverMentionForGroup falls back to plain name, never throws', async () => {
  const resolve = loadResolver({
    async getDriverProfileByGroupId() { throw new Error('db down'); },
    async getGroupByIdAnyType() { return { group_name: 'WENZE UNIT 800 DILSHOD' }; },
  });
  const m = await resolve(7);
  assert.equal(m.confidence, 'low');
  assert.equal(m.displayName, 'WENZE UNIT 800 DILSHOD');
  assert.equal(m.telegramUserId, null);
});
