/**
 * Home-Time driver-group channel — the choke point that enforces silent mode.
 *
 * Everything the bot says to a DRIVER group routes through this module, so these
 * tests are what guarantee that flipping
 * home_time_settings.driver_clarification_enabled to false cannot leak a single
 * message, reminder or reaction into a driver group.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadChannel() {
  const channelPath = path.resolve(__dirname, '../services/homeTimeDriverChannel.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  delete require.cache[channelPath];
  require.cache[htmlPath] = { exports: { safeSend: (fn) => fn() } };
  return require(channelPath);
}

function fakeTelegram() {
  const sends = [];
  const reactions = [];
  return {
    sends,
    reactions,
    async sendMessage(chatId, text, options) {
      sends.push({ chatId, text, options });
      return { message_id: 4242 };
    },
    async setMessageReaction(chatId, messageId, reaction) {
      reactions.push({ chatId, messageId, reaction });
      return true;
    },
  };
}

const ON = { driver_clarification_enabled: true };
const OFF = { driver_clarification_enabled: false };

// ── the switch itself ──

test('messaging defaults to ENABLED when settings are missing or the column is absent', () => {
  const ch = loadChannel();
  assert.equal(ch.isDriverMessagingEnabled(null), true);
  assert.equal(ch.isDriverMessagingEnabled(undefined), true);
  assert.equal(ch.isDriverMessagingEnabled({}), true, 'pre-migration row must not mute the bot');
  assert.equal(ch.isDriverMessagingEnabled({ driver_clarification_enabled: null }), true);
});

test('the switch is read exactly', () => {
  const ch = loadChannel();
  assert.equal(ch.isDriverMessagingEnabled(ON), true);
  assert.equal(ch.isDriverMessagingEnabled(OFF), false);
});

test('the switch is independent of the overall tracking switch', () => {
  const ch = loadChannel();
  // Tracking off but driver messaging on — this module only reads its own column.
  assert.equal(ch.isDriverMessagingEnabled({ enabled: false, driver_clarification_enabled: true }), true);
  assert.equal(ch.isDriverMessagingEnabled({ enabled: true, driver_clarification_enabled: false }), false);
});

test('clarificationChannelFor maps the switch to the stored channel', () => {
  const ch = loadChannel();
  assert.equal(ch.clarificationChannelFor(ON), 'driver');
  assert.equal(ch.clarificationChannelFor(OFF), 'internal');
  assert.equal(ch.clarificationChannelFor(null), 'driver');
});

// ── sending ──

test('ENABLED: a driver-group message is sent, with reply threading', async () => {
  const ch = loadChannel();
  const tg = fakeTelegram();
  const sent = await ch.sendToDriverGroup(tg, '-1007', 'when are you home?', {
    replyToMessageId: 55, settings: ON,
  });
  assert.equal(tg.sends.length, 1);
  assert.equal(tg.sends[0].chatId, '-1007');
  assert.equal(tg.sends[0].text, 'when are you home?');
  assert.equal(tg.sends[0].options.reply_to_message_id, 55);
  assert.equal(tg.sends[0].options.allow_sending_without_reply, true);
  assert.equal(sent.message_id, 4242);
});

test('DISABLED: nothing reaches Telegram and null is returned', async () => {
  const ch = loadChannel();
  const tg = fakeTelegram();
  const sent = await ch.sendToDriverGroup(tg, '-1007', 'when are you home?', {
    replyToMessageId: 55, settings: OFF,
  });
  assert.equal(tg.sends.length, 0, 'no driver-group message may be sent');
  assert.equal(sent, null);
});

test('ENABLED: a 👍 reaction is set', async () => {
  const ch = loadChannel();
  const tg = fakeTelegram();
  await ch.reactToDriverMessage(tg, '-1007', 55, { settings: ON });
  assert.equal(tg.reactions.length, 1);
  assert.deepEqual(tg.reactions[0].reaction, [{ type: 'emoji', emoji: '👍' }]);
});

test('DISABLED: no reaction either — a reaction is still visible to the driver', async () => {
  const ch = loadChannel();
  const tg = fakeTelegram();
  const res = await ch.reactToDriverMessage(tg, '-1007', 55, { settings: OFF });
  assert.equal(tg.reactions.length, 0);
  assert.equal(res, null);
});

test('a reaction failure is non-fatal', async () => {
  const ch = loadChannel();
  const tg = {
    async setMessageReaction() { throw new Error('not an admin'); },
  };
  const res = await ch.reactToDriverMessage(tg, '-1007', 55, { settings: ON });
  assert.equal(res, null); // swallowed, no throw
});

// ── reminder scheduling ──

test('ENABLED: a reminder time passes through unchanged', () => {
  const ch = loadChannel();
  const iso = '2026-08-01T12:00:00.000Z';
  assert.equal(ch.reminderTimeIfAllowed(ON, iso), iso);
  assert.equal(ch.reminderTimeIfAllowed(null, iso), iso);
});

test('DISABLED: no reminder is ever scheduled, so none can later leak or replay', () => {
  const ch = loadChannel();
  assert.equal(ch.reminderTimeIfAllowed(OFF, '2026-08-01T12:00:00.000Z'), null);
});

// ── defensive ──

test('missing chat id or empty text sends nothing even when enabled', async () => {
  const ch = loadChannel();
  const tg = fakeTelegram();
  assert.equal(await ch.sendToDriverGroup(tg, null, 'hi', { settings: ON }), null);
  assert.equal(await ch.sendToDriverGroup(tg, '-1007', '', { settings: ON }), null);
  assert.equal(tg.sends.length, 0);
});
