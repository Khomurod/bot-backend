// config.js fails fast on missing secrets; provide harmless test values before
// loading any module that requires it.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-telegram-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY || 'test-fb-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const handlers = require('../bot/anonymousFeedbackHandlers');

function makeCtx({ chatType = 'private', userId = 555, text, caption, match } = {}) {
  const replies = [];
  const sent = [];
  const answers = [];
  let replyMarkupEdited = false;
  return {
    chat: { type: chatType, id: chatType === 'private' ? userId : -100200 },
    from: { id: userId, username: 'secretuser', first_name: 'Jane', last_name: 'Driver' },
    message: { text, caption },
    match: match || [],
    telegram: {
      sendMessage: async (chatId, body, opts) => { sent.push({ chatId, body, opts }); return { message_id: 1 }; },
    },
    reply: async (body, opts) => { replies.push({ body, opts }); return { message_id: 2 }; },
    answerCbQuery: async (t) => { answers.push(t ?? null); },
    editMessageReplyMarkup: async () => { replyMarkupEdited = true; },
    // expose captured data
    _replies: replies,
    _sent: sent,
    _answers: answers,
    get _replyMarkupEdited() { return replyMarkupEdited; },
  };
}

test.beforeEach(() => {
  handlers._sessions.clear();
});

test('beginAnonymousFeedback asks employee/driver in a private chat', async () => {
  const ctx = makeCtx();
  await handlers.beginAnonymousFeedback(ctx);

  const session = handlers.getSession(555);
  assert.equal(session.step, 'awaiting_role');
  assert.equal(ctx._replies.length, 1);
  assert.match(ctx._replies[0].body, /employee/i);
  assert.match(ctx._replies[0].body, /driver/i);
  // Inline keyboard with the two role buttons is attached.
  const kb = ctx._replies[0].opts.reply_markup.inline_keyboard;
  const datas = kb.flat().map((b) => b.callback_data);
  assert.deepEqual(datas, ['afb_role_employee', 'afb_role_driver']);
});

test('beginAnonymousFeedback is a no-op in group chats', async () => {
  const ctx = makeCtx({ chatType: 'supergroup' });
  await handlers.beginAnonymousFeedback(ctx);
  assert.equal(ctx._replies.length, 0);
  assert.equal(handlers.getSession(555), null);
});

test('role selection moves to awaiting_description and promises anonymity', async () => {
  const ctx = makeCtx({ match: ['afb_role_driver', 'driver'] });
  handlers._sessions.set(555, { step: 'awaiting_role', role: null, expiresAt: Date.now() + 100000 });

  await handlers.handleRoleSelection(ctx);

  const session = handlers.getSession(555);
  assert.equal(session.step, 'awaiting_description');
  assert.equal(session.role, 'Driver');
  assert.equal(ctx._replyMarkupEdited, true);
  const body = ctx._replies[0].body;
  assert.match(body, /100% anonymous/i);
  assert.match(body, /complaint, request, or inquiry/i);
});

test('awaiting_description text is relayed anonymously to the group with NO identity', async () => {
  const ctx = makeCtx({ text: 'The AC in my truck is broken & nobody fixes it.' });
  handlers._sessions.set(555, { step: 'awaiting_description', role: 'Driver', expiresAt: Date.now() + 100000 });

  const handled = await handlers.handlePrivateText(ctx);
  assert.equal(handled, true);

  // Exactly one relay to the group.
  assert.equal(ctx._sent.length, 1);
  const relayed = ctx._sent[0];
  assert.equal(String(relayed.chatId), '-1002997837889');

  // Role and message present.
  assert.match(relayed.body, /Driver/);
  assert.match(relayed.body, /AC in my truck is broken/);
  // HTML-escaped ampersand from user content.
  assert.match(relayed.body, /&amp;/);

  // CRITICAL: absolutely no identifying information leaks.
  assert.ok(!relayed.body.includes('secretuser'), 'username leaked');
  assert.ok(!relayed.body.toLowerCase().includes('jane'), 'first name leaked');
  assert.ok(!relayed.body.includes('555'), 'telegram id leaked');

  // Session cleared and user gets an anonymity confirmation.
  assert.equal(handlers.getSession(555), null);
  assert.match(ctx._replies[0].body, /anonymous/i);
});

test('a fresh private message with no session starts the flow', async () => {
  const ctx = makeCtx({ text: 'hello' });
  const handled = await handlers.handlePrivateText(ctx);
  assert.equal(handled, true);
  assert.equal(handlers.getSession(555).step, 'awaiting_role');
  assert.match(ctx._replies[0].body, /employee/i);
  // Nothing relayed to the group yet.
  assert.equal(ctx._sent.length, 0);
});

test('typing instead of tapping while awaiting_role re-shows the buttons', async () => {
  const ctx = makeCtx({ text: 'employee maybe' });
  handlers._sessions.set(555, { step: 'awaiting_role', role: null, expiresAt: Date.now() + 100000 });

  const handled = await handlers.handlePrivateText(ctx);
  assert.equal(handled, true);
  assert.equal(handlers.getSession(555).step, 'awaiting_role');
  assert.ok(ctx._replies[0].opts.reply_markup.inline_keyboard);
});

test('slash commands fall through (not handled by the text flow)', async () => {
  const ctx = makeCtx({ text: '/start' });
  const handled = await handlers.handlePrivateText(ctx);
  assert.equal(handled, false);
});

test('group text is never handled by the anonymous flow', async () => {
  const ctx = makeCtx({ chatType: 'supergroup', text: 'load update for unit 12' });
  const handled = await handlers.handlePrivateText(ctx);
  assert.equal(handled, false);
  assert.equal(ctx._sent.length, 0);
  assert.equal(ctx._replies.length, 0);
});
