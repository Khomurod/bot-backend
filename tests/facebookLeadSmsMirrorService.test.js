process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/test';
process.env.MANAGEMENT_GROUP_ID = process.env.MANAGEMENT_GROUP_ID || '-1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '3001';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMirrorHtml,
  escapeHtml,
  candidateTelegramChatIds,
  handleTelegramSmsReply,
} = require('../services/facebookLeadSmsMirrorService');

const db = require('../database/db');

test('buildMirrorHtml escapes HTML and wraps SMS in pre', () => {
  const html = buildMirrorHtml({
    leadName: 'Jane <Doe>',
    phone: '+15551234567',
    pageName: 'Wenze & Co',
    ruleLabel: 'Evening',
    smsBody: 'Hi <there>\n& welcome',
  });
  assert.match(html, /Jane &lt;Doe&gt;/);
  assert.match(html, /Wenze &amp; Co/);
  assert.match(html, /<pre>Hi &lt;there&gt;\n&amp; welcome<\/pre>/);
  assert.match(html, /Evening/);
});

test('escapeHtml encodes special characters', () => {
  assert.equal(escapeHtml('a & b <c>'), 'a &amp; b &lt;c&gt;');
});

test('candidateTelegramChatIds includes legacy and supergroup forms', () => {
  const ids = candidateTelegramChatIds('-1001234567890');
  assert.ok(ids.includes(-1001234567890));
  assert.ok(ids.includes(-1234567890));
});

test('handleTelegramSmsReply sends SMS when mirror exists', async () => {
  const originalGet = db.getFacebookLeadSmsMirror;
  const originalFetch = global.fetch;
  const smsBodies = [];

  db.getFacebookLeadSmsMirror = async (chatId, messageId) => {
    if (chatId === -100999 && messageId === 42) {
      return { driver_phone: '+15550001111', telegram_chat_id: -100999 };
    }
    return null;
  };

  process.env.RC_CLIENT_ID = 'test-id';
  process.env.RC_CLIENT_SECRET = 'test-secret';
  process.env.RC_JWT_TOKEN = 'test-jwt';
  process.env.RC_FROM_NUMBER = '+15550009999';

  global.fetch = async (url, options) => {
    const href = String(url);
    if (href.includes('/oauth/token')) {
      return {
        ok: true,
        json: async () => ({ access_token: 'token', expires_in: 3600 }),
      };
    }
    if (href.includes('/sms')) {
      smsBodies.push(JSON.parse(options.body).text);
      return {
        ok: true,
        json: async () => ({ id: 12345, conversationId: 67890 }),
      };
    }
    return originalFetch(url, options);
  };

  try {
    const result = await handleTelegramSmsReply(null, {
      telegramChatId: '-100999',
      replyToMessageId: 42,
      replyText: 'Thanks for applying!',
    });
    assert.equal(result.ok, true);
    assert.equal(result.phone, '+15550001111');
    assert.equal(result.messageId, '12345');
    assert.deepEqual(smsBodies, ['Thanks for applying!']);
  } finally {
    db.getFacebookLeadSmsMirror = originalGet;
    global.fetch = originalFetch;
  }
});

test('handleTelegramSmsReply rejects empty text', async () => {
  await assert.rejects(
    () => handleTelegramSmsReply(null, {
      telegramChatId: '-100999',
      replyToMessageId: 42,
      replyText: '   ',
    }),
    (err) => err.statusCode === 400
  );
});

test('handleTelegramSmsReply returns 404 when mirror missing', async () => {
  const originalGet = db.getFacebookLeadSmsMirror;
  db.getFacebookLeadSmsMirror = async () => null;
  try {
    await assert.rejects(
      () => handleTelegramSmsReply(null, {
        telegramChatId: '-100999',
        replyToMessageId: 99,
        replyText: 'Hello',
      }),
      (err) => err.statusCode === 404
    );
  } finally {
    db.getFacebookLeadSmsMirror = originalGet;
  }
});
