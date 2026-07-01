/**
 * Route tests for /api/bot-messages — admin list / edit / delete of the
 * bot-sent message registry.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

function loadApp({ dbMock, telegram }) {
  const routePath = path.resolve(__dirname, '../server/routes/botMessagesRoutes.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const servicePath = path.resolve(__dirname, '../services/botMessageAdminService.js');
  const botPath = path.resolve(__dirname, '../bot/bot.js');

  for (const p of [routePath, dbPath, servicePath, botPath]) delete require.cache[p];

  require.cache[dbPath] = { exports: dbMock };
  // Stub bot.js so the service's lazy require never loads the real bot.
  require.cache[botPath] = { exports: { bot: { telegram } } };

  const { createBotMessagesRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/bot-messages',
    createBotMessagesRouter({
      authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
      telegram,
    })
  );
  return app;
}

async function call(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET / returns the paginated list', async () => {
  const captured = [];
  const dbMock = {
    async listBotSentMessages(filters) {
      captured.push(filters);
      return { messages: [{ id: 1, message_text: 'hi' }], total: 1, limit: 50, offset: 0 };
    },
  };
  const app = loadApp({ dbMock, telegram: {} });
  const res = await call(app, 'GET', '/api/bot-messages?search=hi&chatId=-1001&limit=25');
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 1);
  assert.equal(captured[0].search, 'hi');
  assert.equal(captured[0].chatId, '-1001');
  assert.equal(captured[0].limit, 25);
});

test('PATCH /:id edits the message and returns the updated row', async () => {
  const edits = [];
  const dbMock = {
    async getBotSentMessageById(id) {
      return { id, telegram_chat_id: '-1001', telegram_message_id: '55', deleted_at: null };
    },
    async markBotSentMessageEdited(chatId, messageId, text) {
      edits.push({ chatId, messageId, text });
      return { id: 7, message_text: text, edited_at: 'now' };
    },
  };
  const telegram = { editMessageText: async () => {} };
  const app = loadApp({ dbMock, telegram });
  const res = await call(app, 'PATCH', '/api/bot-messages/7', { newText: 'updated' });
  assert.equal(res.status, 200);
  assert.equal(res.json.message.message_text, 'updated');
  assert.equal(edits[0].text, 'updated');
});

test('PATCH /:id rejects empty text', async () => {
  const dbMock = { async getBotSentMessageById() { throw new Error('unused'); } };
  const app = loadApp({ dbMock, telegram: {} });
  const res = await call(app, 'PATCH', '/api/bot-messages/7', { newText: '   ' });
  assert.equal(res.status, 400);
});

test('PATCH /:id 404s for an unknown id', async () => {
  const dbMock = { async getBotSentMessageById() { return null; } };
  const app = loadApp({ dbMock, telegram: {} });
  const res = await call(app, 'PATCH', '/api/bot-messages/999', { newText: 'x' });
  assert.equal(res.status, 404);
});

test('PATCH /:id surfaces a Telegram edit failure as 502', async () => {
  const dbMock = {
    async getBotSentMessageById(id) {
      return { id, telegram_chat_id: '-1001', telegram_message_id: '55', deleted_at: null };
    },
    async markBotSentMessageEdited() { throw new Error('should not record'); },
  };
  const telegram = {
    editMessageText: async () => {
      const err = new Error("Bad Request: message can't be edited");
      err.description = "Bad Request: message can't be edited";
      throw err;
    },
  };
  const app = loadApp({ dbMock, telegram });
  const res = await call(app, 'PATCH', '/api/bot-messages/7', { newText: 'x' });
  assert.equal(res.status, 502);
  assert.equal(res.json.reason, 'not_editable');
});

test('DELETE /:id deletes and returns the updated row', async () => {
  let marked = false;
  const dbMock = {
    async getBotSentMessageById(id) {
      return { id, telegram_chat_id: '-1001', telegram_message_id: '55' };
    },
    async markBotSentMessageDeleted() { marked = true; return { id: 7, deleted_at: 'now' }; },
  };
  const telegram = { deleteMessage: async () => {} };
  const app = loadApp({ dbMock, telegram });
  const res = await call(app, 'DELETE', '/api/bot-messages/7');
  assert.equal(res.status, 200);
  assert.equal(res.json.reason, 'deleted');
  assert.equal(marked, true);
});

test('DELETE /:id surfaces an undeletable message as 502', async () => {
  const dbMock = {
    async getBotSentMessageById(id) {
      return { id, telegram_chat_id: '-1001', telegram_message_id: '55' };
    },
    async markBotSentMessageDeleted() { throw new Error('should not mark deleted'); },
  };
  const telegram = {
    deleteMessage: async () => {
      const err = new Error("Bad Request: message can't be deleted");
      err.description = "Bad Request: message can't be deleted";
      throw err;
    },
    editMessageReplyMarkup: async () => {},
  };
  const app = loadApp({ dbMock, telegram });
  const res = await call(app, 'DELETE', '/api/bot-messages/7');
  assert.equal(res.status, 502);
  assert.equal(res.json.reason, 'buttons_removed');
});
