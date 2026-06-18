const test = require('node:test');
const assert = require('node:assert/strict');

const {
  installBotSentMessageTracking,
  resolveForwardedBotMessage,
} = require('../services/botSentMessageRegistry');

test('outbound tracking records successful Telegram messages', async () => {
  const recorded = [];
  const telegram = {
    callApi: async () => ({
      message_id: 91,
      date: 1781450000,
      chat: { id: -5160453235 },
      text: 'Happy Birthday',
    }),
  };
  const db = {
    recordBotSentMessage: async (row) => recorded.push(row),
  };

  assert.equal(installBotSentMessageTracking(telegram, db), true);
  const result = await telegram.callApi('sendMessage', { chat_id: -5160453235 });

  assert.equal(result.message_id, 91);
  assert.deepEqual(recorded, [{
    telegramChatId: '-5160453235',
    telegramMessageId: '91',
    sentAt: new Date(1781450000 * 1000).toISOString(),
    messageText: 'Happy Birthday',
    contentKind: 'text',
    sourceMethod: 'sendMessage',
  }]);
});

test('registry failure never turns a successful send into an error', async () => {
  const warnings = [];
  const telegram = {
    callApi: async () => ({
      message_id: 5,
      date: 1781450000,
      chat: { id: -1001 },
      text: 'sent',
    }),
  };
  installBotSentMessageTracking(
    telegram,
    { recordBotSentMessage: async () => { throw new Error('db offline'); } },
    { warn: (...args) => warnings.push(args.join(' ')) }
  );

  const result = await telegram.callApi('sendMessage', { chat_id: -1001 });
  assert.equal(result.message_id, 5);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /db offline/);
});

test('ordinary group forward resolves by bot sender, timestamp, and text', async () => {
  const target = {
    telegram_chat_id: '-5160453235',
    telegram_message_id: '31627',
    message_text: 'Happy Birthday',
    content_kind: 'text',
  };
  const calls = [];
  const result = await resolveForwardedBotMessage({
    text: 'Happy Birthday',
    forward_origin: {
      type: 'user',
      date: 1781450000,
      sender_user: { id: 555, is_bot: true },
    },
  }, {
    botInfo: { id: 555 },
    db: {
      findBotSentMessagesForForward: async (query) => {
        calls.push(query);
        return [target];
      },
    },
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.target, target);
  assert.deepEqual(calls[0], {
    sentAt: new Date(1781450000 * 1000).toISOString(),
    messageText: 'Happy Birthday',
    telegramChatId: null,
  });
});

test('forward from another sender is rejected before lookup', async () => {
  let lookedUp = false;
  const result = await resolveForwardedBotMessage({
    text: 'not ours',
    forward_origin: {
      type: 'user',
      date: 1781450000,
      sender_user: { id: 999 },
    },
  }, {
    botInfo: { id: 555 },
    db: {
      findBotSentMessagesForForward: async () => {
        lookedUp = true;
        return [];
      },
    },
  });

  assert.equal(result.status, 'not_this_bot');
  assert.equal(lookedUp, false);
});

test('ambiguous forward is refused', async () => {
  const result = await resolveForwardedBotMessage({
    text: 'same',
    forward_origin: {
      type: 'user',
      date: 1781450000,
      sender_user: { id: 555 },
    },
  }, {
    botInfo: { id: 555 },
    db: {
      findBotSentMessagesForForward: async () => [{ id: 1 }, { id: 2 }],
    },
  });
  assert.equal(result.status, 'ambiguous');
});

test('channel forward with source message id still requires a registry match', async () => {
  const target = {
    telegram_chat_id: '-100123',
    telegram_message_id: '88',
    message_text: 'Announcement',
  };
  const result = await resolveForwardedBotMessage({
    text: 'Announcement',
    forward_origin: {
      type: 'channel',
      date: 1781450000,
      chat: { id: -100123 },
      message_id: 88,
    },
  }, {
    db: {
      getBotSentMessage: async (chatId, messageId) => {
        assert.equal(chatId, '-100123');
        assert.equal(messageId, '88');
        return target;
      },
    },
  });
  assert.equal(result.status, 'resolved');
});
