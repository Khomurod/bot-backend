process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/test';
process.env.MANAGEMENT_GROUP_ID = process.env.MANAGEMENT_GROUP_ID || '-1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '3001';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutoMessageSentHtml,
  escapeHtml,
  candidateTelegramChatIds,
  handleTelegramSmsReply,
  registerSmsMirror,
} = require('../services/facebookLeadSmsMirrorService');

const db = require('../database/db');

test('buildAutoMessageSentHtml escapes HTML and wraps SMS in pre', () => {
  const html = buildAutoMessageSentHtml('+15551234567', 'Hi <there>\n& welcome');
  assert.match(html, /AutoMessage sent via SMS to \+15551234567:/);
  assert.match(html, /<pre>Hi &lt;there&gt;\n&amp; welcome<\/pre>/);
  assert.doesNotMatch(html, /Working hours/);
  assert.doesNotMatch(html, /for lead/);
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

test('registerSmsMirror inserts inbound row', async () => {
  const originalInsert = db.insertFacebookLeadSmsMirror;
  let inserted = null;
  db.insertFacebookLeadSmsMirror = async (row) => {
    inserted = row;
    return { ...row, id: 1 };
  };
  try {
    const result = await registerSmsMirror({
      telegramChatId: '-100123',
      telegramMessageId: 55,
      driverPhone: '+15551234567',
      smsBody: 'No thank you',
      sourceType: 'inbound_rc',
    });
    assert.equal(result.ok, true);
    assert.equal(inserted.sourceType, 'inbound_rc');
    assert.equal(inserted.driverPhone, '+15551234567');
    assert.equal(inserted.smsBody, 'No thank you');
  } finally {
    db.insertFacebookLeadSmsMirror = originalInsert;
  }
});

test('registerSmsMirror rejects unknown phone', async () => {
  await assert.rejects(
    () => registerSmsMirror({
      telegramChatId: '-100123',
      telegramMessageId: 55,
      driverPhone: 'Unknown',
      smsBody: 'hi',
      sourceType: 'inbound_rc',
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
