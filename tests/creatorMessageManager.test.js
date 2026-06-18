const test = require('node:test');
const assert = require('node:assert/strict');

require.cache[require.resolve('../database/db')] = { exports: {} };

const {
  CREATOR_USER_ID,
  createCreatorMessageManager,
} = require('../bot/creatorMessageManager');

const target = {
  telegram_chat_id: '-5160453235',
  telegram_message_id: '31627',
  message_text: 'Happy Birthday',
  content_kind: 'text',
  chat_title: 'WENZE UNIT # 310',
};

function creatorCtx(overrides = {}) {
  const calls = [];
  const ctx = {
    from: { id: CREATOR_USER_ID },
    chat: { id: CREATOR_USER_ID, type: 'private' },
    botInfo: { id: 777 },
    message: {
      text: 'Happy Birthday',
      forward_origin: {
        type: 'user',
        date: 1781450000,
        sender_user: { id: 777, is_bot: true },
      },
    },
    reply: async (text, extra) => {
      calls.push({ method: 'reply', text, extra });
      return { message_id: 1 };
    },
    answerCbQuery: async (text) => calls.push({ method: 'answerCbQuery', text }),
    editMessageText: async (text, extra) => {
      calls.push({ method: 'editMessageText', text, extra });
    },
    telegram: {
      deleteMessage: async (chatId, messageId) => {
        calls.push({ method: 'deleteMessage', chatId, messageId });
      },
      editMessageText: async (chatId, messageId, inlineId, text, extra) => {
        calls.push({
          method: 'telegram.editMessageText',
          chatId,
          messageId,
          inlineId,
          text,
          extra,
        });
      },
    },
    ...overrides,
  };
  return { ctx, calls };
}

function databaseMock(overrides = {}) {
  return {
    findBotSentMessagesForForward: async () => [target],
    updateBotSentMessageContent: async () => target,
    markBotSentMessageDeleted: async () => target,
    ...overrides,
  };
}

test('non-creator forwarded message is ignored', async () => {
  let nextCalled = false;
  let lookupCalled = false;
  const manager = createCreatorMessageManager({
    database: databaseMock({
      findBotSentMessagesForForward: async () => {
        lookupCalled = true;
        return [target];
      },
    }),
  });
  const { ctx, calls } = creatorCtx({ from: { id: 123 } });

  await manager.handleForward(ctx, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(lookupCalled, false);
  assert.equal(calls.length, 0);
});

test('creator forward receives edit, delete, and cancel choices', async () => {
  const manager = createCreatorMessageManager({
    database: databaseMock(),
    createToken: () => 'abcd',
  });
  const { ctx, calls } = creatorCtx();

  await manager.handleForward(ctx, () => {});

  assert.equal(manager.sessions.size, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Manage this message/);
  const keyboard = calls[0].extra.reply_markup.inline_keyboard.flat();
  assert.deepEqual(
    keyboard.map((button) => button.callback_data),
    ['mm:e:abcd', 'mm:d:abcd', 'mm:c:abcd']
  );
});

test('delete requires confirmation and only then deletes target', async () => {
  const deletedRows = [];
  const manager = createCreatorMessageManager({
    database: databaseMock({
      markBotSentMessageDeleted: async (...args) => deletedRows.push(args),
    }),
    createToken: () => 'abcd',
  });
  const initial = creatorCtx();
  await manager.handleForward(initial.ctx, () => {});

  const firstClick = creatorCtx({ match: ['mm:d:abcd', 'abcd'] });
  await manager.handleDeleteAction(firstClick.ctx);
  assert.equal(
    firstClick.calls.some((call) => call.method === 'deleteMessage'),
    false
  );
  assert.match(
    firstClick.calls.find((call) => call.method === 'editMessageText').text,
    /Delete this message/
  );

  const confirm = creatorCtx({ match: ['mm:x:abcd', 'abcd'] });
  await manager.handleDeleteConfirm(confirm.ctx);
  assert.deepEqual(
    confirm.calls.find((call) => call.method === 'deleteMessage'),
    {
      method: 'deleteMessage',
      chatId: '-5160453235',
      messageId: 31627,
    }
  );
  assert.deepEqual(deletedRows, [['-5160453235', '31627']]);
  assert.equal(manager.sessions.size, 0);
  assert.match(
    confirm.calls.find((call) => call.method === 'editMessageText').text,
    /birthday run history was not changed/
  );
});

test('edit action waits for creator replacement and edits original message', async () => {
  const updates = [];
  const manager = createCreatorMessageManager({
    database: databaseMock({
      updateBotSentMessageContent: async (...args) => updates.push(args),
    }),
    createToken: () => 'abcd',
  });
  const initial = creatorCtx();
  await manager.handleForward(initial.ctx, () => {});

  const editClick = creatorCtx({ match: ['mm:e:abcd', 'abcd'] });
  await manager.handleEditAction(editClick.ctx);
  assert.equal(manager.pendingEdits.size, 1);

  const replacement = creatorCtx({
    message: {
      text: 'Updated birthday wish',
      entities: [{ offset: 0, length: 7, type: 'bold' }],
    },
  });
  await manager.handleForward(replacement.ctx, () => {});

  assert.deepEqual(
    replacement.calls.find((call) => call.method === 'telegram.editMessageText'),
    {
      method: 'telegram.editMessageText',
      chatId: '-5160453235',
      messageId: 31627,
      inlineId: undefined,
      text: 'Updated birthday wish',
      extra: {
        entities: [{ offset: 0, length: 7, type: 'bold' }],
      },
    }
  );
  assert.deepEqual(
    updates,
    [['-5160453235', '31627', 'Updated birthday wish', 'text']]
  );
  assert.equal(manager.pendingEdits.size, 0);
});
