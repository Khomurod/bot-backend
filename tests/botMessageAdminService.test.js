const test = require('node:test');
const assert = require('node:assert/strict');

const { editBotMessage, deleteBotMessage } = require('../services/botMessageAdminService');

function tgError(description) {
  const err = new Error(description);
  err.description = description;
  return err;
}

test('editBotMessage edits in Telegram and records the new text', async () => {
  const calls = [];
  const recorded = [];
  const telegram = {
    editMessageText: async (...args) => { calls.push(args); },
  };
  const database = {
    markBotSentMessageEdited: async (chatId, messageId, text) => {
      recorded.push({ chatId, messageId, text });
      return { id: 1, message_text: text };
    },
  };

  const result = await editBotMessage('-1001', '55', 'new text', { telegram, database });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'edited');
  assert.deepEqual(calls[0], ['-1001', 55, undefined, 'new text']);
  assert.deepEqual(recorded[0], { chatId: '-1001', messageId: '55', text: 'new text' });
});

test('editBotMessage rejects empty replacement text without calling Telegram', async () => {
  let called = false;
  const result = await editBotMessage('-1001', '55', '   ', {
    telegram: { editMessageText: async () => { called = true; } },
    database: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty_text');
  assert.equal(called, false);
});

test('editBotMessage treats "message is not modified" as success', async () => {
  let recorded = false;
  const result = await editBotMessage('-1001', '55', 'same', {
    telegram: { editMessageText: async () => { throw tgError('Bad Request: message is not modified'); } },
    database: { markBotSentMessageEdited: async () => { recorded = true; return { id: 1 }; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'not_modified');
  assert.equal(recorded, true);
});

test('editBotMessage surfaces "message can\'t be edited" (too old) as a failure', async () => {
  const result = await editBotMessage('-1001', '55', 'x', {
    telegram: { editMessageText: async () => { throw tgError("Bad Request: message can't be edited"); } },
    database: { markBotSentMessageEdited: async () => { throw new Error('should not be called'); } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_editable');
  assert.match(result.error, /can't be edited/);
});

test('editBotMessage falls back to caption for media messages', async () => {
  const captionCalls = [];
  const result = await editBotMessage('-1001', '55', 'cap', {
    telegram: {
      editMessageText: async () => { throw tgError('Bad Request: there is no text in the message to edit'); },
      editMessageCaption: async (...args) => { captionCalls.push(args); },
    },
    database: { markBotSentMessageEdited: async () => ({ id: 1 }) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'edited_caption');
  assert.deepEqual(captionCalls[0], ['-1001', 55, undefined, 'cap']);
});

test('deleteBotMessage deletes in Telegram and marks the row deleted', async () => {
  const calls = [];
  let marked = false;
  const result = await deleteBotMessage('-1001', '55', {
    telegram: { deleteMessage: async (...args) => { calls.push(args); } },
    database: { markBotSentMessageDeleted: async () => { marked = true; return { id: 1, deleted_at: 'now' }; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'deleted');
  assert.deepEqual(calls[0], ['-1001', 55]);
  assert.equal(marked, true);
});

test('deleteBotMessage treats "message to delete not found" as already gone', async () => {
  let marked = false;
  const result = await deleteBotMessage('-1001', '55', {
    telegram: { deleteMessage: async () => { throw tgError('Bad Request: message to delete not found'); } },
    database: { markBotSentMessageDeleted: async () => { marked = true; return { id: 1 }; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already_gone');
  assert.equal(marked, true);
});

test('deleteBotMessage falls back to stripping buttons when undeletable', async () => {
  let markupStripped = false;
  const result = await deleteBotMessage('-1001', '55', {
    telegram: {
      deleteMessage: async () => { throw tgError("Bad Request: message can't be deleted"); },
      editMessageReplyMarkup: async () => { markupStripped = true; },
    },
    database: { markBotSentMessageDeleted: async () => { throw new Error('should not mark deleted'); } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'buttons_removed');
  assert.equal(markupStripped, true);
});

test('deleteBotMessage surfaces unexpected Telegram errors', async () => {
  const result = await deleteBotMessage('-1001', '55', {
    telegram: { deleteMessage: async () => { throw tgError('Forbidden: bot was kicked'); } },
    database: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'telegram_error');
  assert.match(result.error, /kicked/i);
});
