/**
 * A DRIVER REPLIES TO THE NUMBER THAT TEXTED THEM.
 *
 * Once a lead is texted from the assigned recruiter's own number, the reply a
 * recruiter types in Telegram has to leave from that SAME number. Otherwise the
 * conversation jumps to the shared company line and the driver sees a stranger's
 * number halfway through — which is the bug this feature would introduce if the
 * mirror did not remember its sender.
 *
 * The collaborators are replaced at the module seam (the mirror service
 * destructures them at require time), so nothing here reaches RingCentral or a
 * database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://localhost/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1';
process.env.JWT_SECRET ||= 'test-secret';
process.env.PORT ||= '3001';

const DB_PATH = require.resolve('../database/db');
const RC_PATH = require.resolve('../database/ringcentral');
const SMS_PATH = require.resolve('../services/ringCentralSmsService');
const TG_PATH = require.resolve('../services/telegramHtml');
const LEADS_TG_PATH = require.resolve('../services/leadsTelegramClient');
const MIRROR_PATH = require.resolve('../services/facebookLeadSmsMirrorService');

const JANE = { id: 7, name: 'Jane Doe', phone_number: '+15557770000', refresh_token_encrypted: 'enc' };

function loadMirror({
  mirror = null,
  recruiters = { 7: JANE },
  canSend = true,
  recruiterSend = { ok: true, fromNumber: '+15557770000', messageId: 'rc-own' },
  sharedSend = { ok: true, fromNumber: '+14704804679', messageId: 'rc-shared' },
  sentTelegram = [],
} = {}) {
  const calls = { asRecruiter: [], shared: [], inserted: [] };

  require.cache[DB_PATH] = {
    exports: {
      getFacebookLeadSmsMirror: async () => mirror,
      insertFacebookLeadSmsMirror: async (row) => { calls.inserted.push(row); return { ...row, id: 1 }; },
    },
  };
  require.cache[RC_PATH] = {
    exports: {
      getRecruiterById: async (id) => recruiters[id] || null,
      getRecruiterByNormalizedNumber: async (norm) => Object.values(recruiters)
        .find((r) => String(r.phone_number || '').replace(/\D/g, '').slice(-10) === norm) || null,
      normalizePhone: (v) => String(v || '').replace(/\D/g, '').slice(-10),
      recruiterCanSendSms: () => canSend,
    },
  };
  require.cache[SMS_PATH] = {
    exports: {
      sendSms: async (to, text) => { calls.shared.push({ to, text }); return sharedSend; },
      sendSmsAsRecruiter: async (recruiter, to, text) => {
        calls.asRecruiter.push({ as: recruiter.id, to, text });
        return recruiterSend;
      },
    },
  };
  // Destructured at require time by the service, so it is fixed here, not
  // mutated afterwards.
  require.cache[TG_PATH] = {
    exports: {
      sendTelegramHtmlChunks: async (telegram, chatId, html) => {
        calls.html = html;
        return sentTelegram;
      },
      safeSend: async (fn) => fn(),
    },
  };
  require.cache[LEADS_TG_PATH] = { exports: { toSupergroupStyleChatId: (id) => id } };

  delete require.cache[MIRROR_PATH];
  const mirrorService = require(MIRROR_PATH);
  const restore = () => {
    for (const path of [DB_PATH, RC_PATH, SMS_PATH, TG_PATH, LEADS_TG_PATH, MIRROR_PATH]) {
      delete require.cache[path];
    }
  };
  return { mirrorService, calls, restore };
}

test('a reply on a recruiter mirror goes out from that recruiter', async () => {
  const { mirrorService, calls, restore } = loadMirror({
    mirror: {
      driver_phone: '+15550001111',
      telegram_chat_id: -100999,
      recruiter_id: 7,
      from_number: '+15557770000',
    },
  });
  try {
    const result = await mirrorService.handleTelegramSmsReply(null, {
      telegramChatId: '-100999',
      replyToMessageId: 42,
      replyText: 'Are you still interested?',
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, 'recruiter');
    assert.equal(result.fromNumber, '+15557770000');
    assert.deepEqual(calls.asRecruiter, [{ as: 7, to: '+15550001111', text: 'Are you still interested?' }]);
    assert.deepEqual(calls.shared, [], 'the shared number is never touched');
  } finally { restore(); }
});

test('a mirror with no sender uses the shared number, exactly as before', async () => {
  // Every mirror row written before this feature, and every lead that fell
  // back to the shared number, looks like this.
  const { mirrorService, calls, restore } = loadMirror({
    mirror: { driver_phone: '+15550001111', telegram_chat_id: -100999 },
  });
  try {
    const result = await mirrorService.handleTelegramSmsReply(null, {
      telegramChatId: '-100999', replyToMessageId: 42, replyText: 'Hello',
    });
    assert.equal(result.via, 'shared');
    assert.equal(result.messageId, 'rc-shared');
    assert.deepEqual(calls.asRecruiter, []);
    assert.equal(calls.shared.length, 1);
  } finally { restore(); }
});

test('a recruiter whose credentials broke still gets the reply delivered', async () => {
  const { mirrorService, calls, restore } = loadMirror({
    mirror: { driver_phone: '+15550001111', telegram_chat_id: -100999, recruiter_id: 7 },
    recruiterSend: { ok: false, reason: 'recruiter_auth_failed', detail: 'invalid_grant' },
  });
  try {
    const result = await mirrorService.handleTelegramSmsReply(null, {
      telegramChatId: '-100999', replyToMessageId: 42, replyText: 'Hello?',
    });
    // Losing a driver's answer is worse than answering from the shared number.
    assert.equal(result.ok, true);
    assert.equal(result.via, 'shared');
    assert.equal(calls.asRecruiter.length, 1, 'their number was tried first');
    assert.equal(calls.shared.length, 1);
  } finally { restore(); }
});

test('a deleted recruiter, or one who lost their credentials, falls back', async () => {
  for (const [label, options] of [
    ['recruiter row gone', { recruiters: {} }],
    ['credentials gone', { canSend: false }],
  ]) {
    const { mirrorService, calls, restore } = loadMirror({
      mirror: { driver_phone: '+15550001111', telegram_chat_id: -100999, recruiter_id: 7 },
      ...options,
    });
    try {
      const result = await mirrorService.handleTelegramSmsReply(null, {
        telegramChatId: '-100999', replyToMessageId: 42, replyText: 'Hi',
      });
      assert.equal(result.via, 'shared', label);
      assert.deepEqual(calls.asRecruiter, [], label);
      assert.equal(calls.shared.length, 1, label);
    } finally { restore(); }
  }
});

test('a failed send is still a 502, from either number', async () => {
  const { mirrorService, restore } = loadMirror({
    mirror: { driver_phone: '+15550001111', telegram_chat_id: -100999 },
    sharedSend: { ok: false, reason: 'not_configured' },
  });
  try {
    await assert.rejects(
      () => mirrorService.handleTelegramSmsReply(null, {
        telegramChatId: '-100999', replyToMessageId: 42, replyText: 'Hi',
      }),
      (err) => err.statusCode === 502,
    );
  } finally { restore(); }
});

test('an inbound SMS records WHICH of our numbers it reached', async () => {
  const { mirrorService, calls, restore } = loadMirror();
  try {
    await mirrorService.registerSmsMirror({
      telegramChatId: '-100123',
      telegramMessageId: 55,
      driverPhone: '+15550001111',
      smsBody: 'No thank you',
      sourceType: 'inbound_rc',
      toNumber: '+1 (555) 777-0000',
    });
    assert.equal(calls.inserted[0].recruiterId, 7, 'the reply must go back out from Jane');
    assert.equal(calls.inserted[0].fromNumber, '+15557770000', 'stored in the recruiter row\'s own format');

    // A number that is not a recruiter's (the shared line) records no sender.
    await mirrorService.registerSmsMirror({
      telegramChatId: '-100123',
      telegramMessageId: 56,
      driverPhone: '+15550001111',
      smsBody: 'ok',
      sourceType: 'inbound_rc',
      toNumber: '+14704804679',
    });
    assert.equal(calls.inserted[1].recruiterId, null);
    assert.equal(calls.inserted[1].fromNumber, '+14704804679');

    // And no recipient at all is the pre-recruiter behaviour, not an error.
    await mirrorService.registerSmsMirror({
      telegramChatId: '-100123',
      telegramMessageId: 57,
      driverPhone: '+15550001111',
      smsBody: 'ok',
      sourceType: 'inbound_rc',
    });
    assert.equal(calls.inserted[2].recruiterId, null);
    assert.equal(calls.inserted[2].fromNumber, null);
  } finally { restore(); }
});

test('an explicit recruiter id wins over matching by number', async () => {
  const { mirrorService, restore } = loadMirror();
  try {
    const resolved = await mirrorService.resolveSenderForNumber({
      recruiterId: 12, fromNumber: '+15551110000', toNumber: '+15557770000',
    });
    assert.deepEqual(resolved, { recruiterId: 12, fromNumber: '+15551110000' });
  } finally { restore(); }
});

test('a database failure while matching the number does not lose the mirror', async () => {
  const { mirrorService, restore } = loadMirror();
  const rc = require('../database/ringcentral');
  const original = rc.getRecruiterByNormalizedNumber;
  rc.getRecruiterByNormalizedNumber = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const resolved = await mirrorService.resolveSenderForNumber({ toNumber: '+15557770000' });
    assert.deepEqual(resolved, { recruiterId: null, fromNumber: '+15557770000' });
  } finally {
    rc.getRecruiterByNormalizedNumber = original;
    restore();
  }
});

test('the outbound notice stores the sender on the mirror it creates', async () => {
  const { mirrorService, calls, restore } = loadMirror({
    sentTelegram: [{ message_id: 555, chat: { id: -100999 } }],
  });
  try {
    const result = await mirrorService.sendAutoMessageSentNotice({ sendMessage: async () => ({}) }, -100999, {
      phone: '+15550001111',
      smsBody: 'Hi Alex',
      leadName: 'Alex Driver',
      recruiterId: 7,
      recruiterName: 'Jane Doe',
      fromNumber: '+15557770000',
    });
    assert.equal(result.ok, true);
    assert.equal(calls.inserted[0].recruiterId, 7);
    assert.equal(calls.inserted[0].fromNumber, '+15557770000');
    assert.equal(calls.inserted[0].sourceType, 'outbound_auto');
    assert.match(calls.html, /from Jane Doe \(\+15557770000\)/, 'the group sees who sent it');
  } finally { restore(); }
});

test('a fallback to the shared number is announced in the Telegram notice', async () => {
  // An expired RingCentral login otherwise looks exactly like success.
  const { mirrorService, calls, restore } = loadMirror({
    sentTelegram: [{ message_id: 556, chat: { id: -100999 } }],
  });
  try {
    await mirrorService.sendAutoMessageSentNotice({ sendMessage: async () => ({}) }, -100999, {
      phone: '+15550001111',
      smsBody: 'Hi Alex',
      senderNote: 'Jane Doe could not authenticate with RingCentral (re-connect their account) — sent from the shared number.',
    });
    assert.match(calls.html, /⚠️/);
    assert.match(calls.html, /re-connect their account/);
    assert.equal(calls.inserted[0].recruiterId, null);
  } finally { restore(); }
});
