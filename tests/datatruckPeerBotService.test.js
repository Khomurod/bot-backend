const test = require('node:test');
const assert = require('node:assert/strict');

const apiCalls = [];
const banterCalls = [];

const activeDriverGroup = {
  id: 1,
  group_type: 'driver',
  active: true,
  telegram_group_id: '-100111',
};

const inactiveGroup = { id: 2, group_type: 'driver', active: false };
const employeeGroup = { id: 3, group_type: 'employee', active: true };

require.cache[require.resolve('../config/config')] = {
  exports: {
    datatruckPeerEnabled: true,
    datatruckPeerBotUsername: 'datatruck_driver_bot',
    datatruckLoadFlameChance: 1,
    datatruckBanterMaxPerHourPerChat: 10,
  },
};

require.cache[require.resolve('../database/db')] = {
  exports: {
    getGroupByTelegramId: async (chatId) => {
      if (String(chatId) === '-100111') return activeDriverGroup;
      if (String(chatId) === '-100222') return inactiveGroup;
      if (String(chatId) === '-100333') return employeeGroup;
      return null;
    },
  },
};

require.cache[require.resolve('../services/telegramHtml')] = {
  exports: {
    safeSend: async (fn) => fn(),
  },
};

require.cache[require.resolve('../services/datatruckBanterMessage')] = {
  exports: {
    generateDatatruckBanterMessage: async ({ failureSnippet, excludeTexts }) => {
      banterCalls.push({ failureSnippet, excludeTexts });
      return {
        message: `Roast for: ${failureSnippet.slice(0, 20)}`,
        provider: 'test',
        model: null,
      };
    },
  },
};

const {
  handleDatatruckPeerMessage,
  resetDatatruckPeerStateForTests,
  recordAction,
} = require('../services/datatruckPeerBotService');

function buildCtx({
  chatId = '-100111',
  text = 'Load #: 12345',
  from = { is_bot: true, username: 'datatruck_driver_bot' },
  replyTo = null,
  messageId = 99,
} = {}) {
  return {
    me: 'wenzefeedback_bot',
    chat: { id: chatId, type: 'supergroup' },
    from,
    message: {
      message_id: messageId,
      text,
      reply_to_message: replyTo,
    },
    telegram: {
      callApi: async (method, payload) => {
        apiCalls.push({ method, payload });
        return true;
      },
      sendMessage: async (chatIdArg, body, opts) => {
        apiCalls.push({ method: 'sendMessage', payload: { chatIdArg, body, opts } });
        return { message_id: 1000 };
      },
    },
  };
}

test.beforeEach(() => {
  apiCalls.length = 0;
  banterCalls.length = 0;
  resetDatatruckPeerStateForTests();
});

test('ignores non-bot senders', async () => {
  const result = await handleDatatruckPeerMessage(buildCtx({
    from: { is_bot: false, username: 'human' },
  }));
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not_peer_bot');
  assert.equal(apiCalls.length, 0);
});

test('ignores wrong bot username', async () => {
  const result = await handleDatatruckPeerMessage(buildCtx({
    from: { is_bot: true, username: 'other_bot' },
  }));
  assert.equal(result.reason, 'not_peer_bot');
});

test('ignores inactive driver groups', async () => {
  const result = await handleDatatruckPeerMessage(buildCtx({ chatId: '-100222' }));
  assert.equal(result.reason, 'not_active_driver_group');
});

test('ignores non-driver groups', async () => {
  const result = await handleDatatruckPeerMessage(buildCtx({ chatId: '-100333' }));
  assert.equal(result.reason, 'not_active_driver_group');
});

test('load message triggers setMessageReaction with thumbs and fire', async () => {
  const result = await handleDatatruckPeerMessage(buildCtx({
    text: 'Load #: 418911\nPU # : 55',
  }), { random: () => 0 });

  assert.equal(result.handled, true);
  assert.equal(result.action, 'react_load');
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].method, 'setMessageReaction');
  assert.deepEqual(apiCalls[0].payload.reaction, [
    { type: 'emoji', emoji: '👍' },
    { type: 'emoji', emoji: '🔥' },
  ]);
});

test('failure message triggers banter reply', async () => {
  const result = await handleDatatruckPeerMessage(buildCtx({
    text: 'Unknown command. Please use a valid command.',
  }));

  assert.equal(result.handled, true);
  assert.equal(result.action, 'banter');
  assert.equal(banterCalls.length, 1);
  const send = apiCalls.find((c) => c.method === 'sendMessage');
  assert.ok(send);
  assert.equal(send.payload.opts.reply_to_message_id, 99);
});

test('skips when message is reply to Wenze', async () => {
  const result = await handleDatatruckPeerMessage(buildCtx({
    text: 'Unknown command. Please use a valid command.',
    replyTo: {
      message_id: 50,
      from: { is_bot: true, username: 'wenzefeedback_bot' },
    },
  }));

  assert.equal(result.reason, 'reply_to_wenze');
  assert.equal(apiCalls.length, 0);
});

test('rate limit blocks further actions in same chat', async () => {
  const chatId = '-100111';
  const now = Date.now();
  for (let i = 0; i < 10; i += 1) {
    recordAction(chatId, now);
  }

  const result = await handleDatatruckPeerMessage(buildCtx({
    text: 'Load #: 99999',
  }));

  assert.equal(result.reason, 'rate_limited');
  assert.equal(apiCalls.length, 0);
});

test('disabled via config skips processing', async () => {
  require.cache[require.resolve('../config/config')].exports.datatruckPeerEnabled = false;
  const result = await handleDatatruckPeerMessage(buildCtx());
  assert.equal(result.reason, 'disabled');
  require.cache[require.resolve('../config/config')].exports.datatruckPeerEnabled = true;
});
