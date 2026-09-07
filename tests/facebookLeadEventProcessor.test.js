/**
 * One Facebook lead, end to end through the processor.
 *
 * The ORDER is the contract, and it is ordered by what a lead cannot afford to
 * lose: the Telegram post happens first and nothing after it can prevent it;
 * the CRM record and the `leads` row are best-effort; the text is sent from the
 * assigned recruiter's number and, whatever happens, is sent. These tests
 * assert that shape from the outside, with every collaborator faked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const PATHS = {
  db: require.resolve('../database/db'),
  crypto: require.resolve('../lib/security/facebookCrypto'),
  mirror: require.resolve('../services/facebookLeadSmsMirrorService'),
  telegramHtml: require.resolve('../services/telegramHtml'),
  graph: require.resolve('../services/facebookGraphService'),
  autoMessage: require.resolve('../services/facebookLeadAutoMessageService'),
  sender: require.resolve('../services/facebookLeadSmsSender'),
  bitrix: require.resolve('../services/bitrix24Service'),
  processor: require.resolve('../services/facebookLeadEventProcessor'),
};

const EVENT = {
  id: 1,
  page_id: '9001',
  event_type: 'leadgen',
  payload: { leadgenId: 'lg-1', value: { form_id: 'form-7' } },
};

function loadProcessor({
  connection = { page_name: 'Wenze Recruiting', telegram_group_id: '-1005555555555', access_token_encrypted: 'enc' },
  bitrix = { ok: true, bitrixId: 'B-1', entity: 'lead' },
  bitrixThrows = null,
  leadRow = { id: 77 },
  leadRecordThrows = null,
  autoSms = { isEnabled: true, template: 'Hi {{first_name}}', settings: {}, ruleLabel: 'default' },
  senderResult = {
    smsResult: { ok: true, messageId: 'rc-own' },
    via: 'recruiter',
    recruiter: { id: 7, name: 'Jane Doe' },
    recruiterId: 7,
    assignedById: 17,
    fromNumber: '+15557770000',
    fallbackReason: null,
    fallbackNote: null,
  },
  senderUpdateThrows = null,
} = {}) {
  const calls = { telegram: [], notices: [], bitrix: [], leads: [], senderWrites: [], sends: [] };

  require.cache[PATHS.db] = {
    exports: {
      getFacebookPageConnectionByPageId: async () => connection,
      createLeadIfNew: async (row) => { calls.leads.push(row); if (leadRecordThrows) throw leadRecordThrows; return leadRow; },
      updateLeadBitrixResult: async (id, payload) => { calls.leads.push({ bitrixResult: { id, ...payload } }); },
      updateLeadSmsSender: async (id, payload) => {
        if (senderUpdateThrows) throw senderUpdateThrows;
        calls.senderWrites.push({ id, ...payload });
      },
    },
  };
  require.cache[PATHS.crypto] = { exports: { decryptText: () => 'page-token' } };
  require.cache[PATHS.mirror] = {
    exports: { sendAutoMessageSentNotice: async (telegram, chatId, payload) => { calls.notices.push(payload); return { ok: true }; } },
  };
  require.cache[PATHS.telegramHtml] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[PATHS.graph] = {
    exports: {
      fetchLeadById: async () => ({
        id: 'lg-1',
        field_data: [
          { name: 'full_name', values: ['Alex Driver'] },
          { name: 'phone_number', values: ['+15559998888'] },
        ],
      }),
    },
  };
  require.cache[PATHS.autoMessage] = {
    exports: { resolveAutoSmsForLead: async () => autoSms, LEGACY_HARDCODED_TEMPLATE: 'legacy' },
  };
  require.cache[PATHS.sender] = {
    exports: {
      sendLeadSms: async (args) => {
        calls.sends.push(args);
        if (typeof senderResult === 'function') return senderResult(args);
        return senderResult;
      },
    },
  };
  require.cache[PATHS.bitrix] = {
    exports: {
      createCrmRecordFromLead: async (args) => {
        calls.bitrix.push(args);
        if (bitrixThrows) throw bitrixThrows;
        return bitrix;
      },
    },
  };
  delete require.cache[PATHS.processor];
  const processor = require(PATHS.processor);
  const telegram = { sendMessage: async (chatId, text) => { calls.telegram.push({ chatId, text }); return { message_id: calls.telegram.length }; } };
  const restore = () => { for (const path of Object.values(PATHS)) delete require.cache[path]; };
  return { processor, telegram, calls, restore };
}

test('the lead is posted, filed, and texted from the assigned recruiter', async () => {
  const { processor, telegram, calls, restore } = loadProcessor();
  try {
    await processor.processLeadEvent(EVENT, { telegram });

    assert.equal(calls.telegram.length, 1, 'the group sees the lead');
    assert.match(calls.telegram[0].text, /Alex Driver/);
    assert.equal(calls.bitrix.length, 1);

    // The CRM record id is what the sender needs to ask who owns the lead.
    assert.equal(calls.sends.length, 1);
    assert.deepEqual(
      { phone: calls.sends[0].phone, bitrixId: calls.sends[0].bitrixId, entity: calls.sends[0].entity },
      { phone: '+15559998888', bitrixId: 'B-1', entity: 'lead' },
    );
    // The body is whatever the template renderer produced — its own tests pin
    // the syntax; here it only has to be the rendered lead message.
    assert.match(calls.sends[0].message, /Alex/);

    // Who texted is recorded on the lead for the admin Leads tab.
    assert.deepEqual(calls.senderWrites, [{
      id: 77, assignedById: 17, fromNumber: '+15557770000', recruiterId: 7,
    }]);

    // …and on the mirror, so the driver's reply comes back to the same number.
    assert.deepEqual(calls.notices.length, 1);
    assert.deepEqual(
      {
        recruiterId: calls.notices[0].recruiterId,
        recruiterName: calls.notices[0].recruiterName,
        fromNumber: calls.notices[0].fromNumber,
        note: calls.notices[0].senderNote,
      },
      { recruiterId: 7, recruiterName: 'Jane Doe', fromNumber: '+15557770000', note: null },
    );
  } finally { restore(); }
});

test('a fallback to the shared number is carried into the Telegram notice', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    senderResult: {
      smsResult: { ok: true, messageId: 'rc-shared' },
      via: 'shared',
      recruiter: null,
      recruiterId: null,
      assignedById: 17,
      fromNumber: '+14704804679',
      fallbackReason: 'recruiter_auth_failed',
      fallbackNote: 'Jane Doe could not authenticate with RingCentral — sent from the shared number.',
    },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.match(calls.notices[0].senderNote, /could not authenticate/);
    assert.equal(calls.notices[0].recruiterId, null);
    assert.equal(calls.notices[0].fromNumber, '+14704804679');
    // The assignee is still recorded even though they did not send.
    assert.equal(calls.senderWrites[0].assignedById, 17);
    assert.equal(calls.senderWrites[0].recruiterId, null);
  } finally { restore(); }
});

test('a Bitrix outage does not stop the lead being texted', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    bitrixThrows: new Error('Bitrix unreachable'),
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.telegram.length, 1);
    assert.equal(calls.sends.length, 1);
    assert.equal(calls.sends[0].bitrixId, null, 'no record means no assignee to look up');
  } finally { restore(); }
});

test('a failed Bitrix response is recorded as such, and the send still happens', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    bitrix: { ok: false, reason: 'api_error', error: 'boom' },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    const bitrixWrite = calls.leads.find((row) => row.bitrixResult);
    assert.equal(bitrixWrite.bitrixResult.status, 'failed');
    assert.equal(calls.sends[0].bitrixId, null);
  } finally { restore(); }
});

test('a lead that cannot be recorded is still posted and texted', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    leadRecordThrows: new Error('leads table unavailable'),
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.telegram.length, 1);
    assert.equal(calls.sends.length, 1);
    assert.deepEqual(calls.senderWrites, [], 'no lead row, nothing to annotate');
  } finally { restore(); }
});

test('a duplicate lead (already recorded) skips the annotation, not the text', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({ leadRow: null });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.sends.length, 1);
    assert.deepEqual(calls.senderWrites, []);
  } finally { restore(); }
});

test('failing to record the sender never fails the lead', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    senderUpdateThrows: new Error('column missing'),
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.notices.length, 1, 'processing continued past the bookkeeping write');
  } finally { restore(); }
});

test('auto-SMS disabled in admin posts a skip notice and sends nothing', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    autoSms: { isEnabled: false, ruleLabel: 'off' },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.sends.length, 0);
    assert.equal(calls.notices.length, 0);
    assert.equal(calls.telegram.length, 2, 'the lead post plus the skip notice');
    assert.match(calls.telegram[1].text, /auto-SMS is disabled/);
  } finally { restore(); }
});

test('a lead with no phone is posted and reported, never sent', async () => {
  const { processor, telegram, calls, restore } = loadProcessor();
  const noPhone = { ...EVENT, payload: { ...EVENT.payload } };
  require.cache[PATHS.graph] = {
    exports: { fetchLeadById: async () => ({ id: 'lg-1', field_data: [{ name: 'full_name', values: ['Alex Driver'] }] }) },
  };
  delete require.cache[PATHS.processor];
  const reloaded = require(PATHS.processor);
  try {
    await reloaded.processLeadEvent(noPhone, { telegram });
    assert.equal(calls.sends.length, 0);
    assert.match(calls.telegram[1].text, /no phone on lead/);
  } finally { restore(); }
});

test('a failed send appends the sender fallback to the failure notice', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    senderResult: {
      smsResult: { ok: false, reason: 'http_400', detail: 'Not registered' },
      via: 'shared',
      recruiter: null,
      recruiterId: null,
      assignedById: null,
      fromNumber: null,
      fallbackReason: 'unassigned',
      fallbackNote: 'Bitrix had not assigned the lead yet — sent from the shared number.',
    },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.notices.length, 0, 'nothing was sent, so nothing to mirror');
    assert.match(calls.telegram[1].text, /AutoMessage failed/);
    assert.match(calls.telegram[1].text, /had not assigned the lead/);
  } finally { restore(); }
});

test('a leadgen event with no id, or an unknown page, is a hard error', async () => {
  const { processor, telegram, restore } = loadProcessor();
  try {
    await assert.rejects(
      () => processor.processLeadEvent({ ...EVENT, payload: {} }, { telegram }),
      /missing leadgenId/,
    );
  } finally { restore(); }

  const noConnection = loadProcessor({ connection: null });
  try {
    await assert.rejects(
      () => noConnection.processor.processLeadEvent(EVENT, { telegram: noConnection.telegram }),
      /No active Facebook Page connection/,
    );
  } finally { noConnection.restore(); }
});

test('buildAutoMessageNotification is still exported from the queue service', () => {
  // Its callers have always imported it from there; the split must not move it.
  const queue = require('../services/facebookWebhookService');
  assert.equal(typeof queue.buildAutoMessageNotification, 'function');
  assert.equal(
    queue.buildAutoMessageNotification({ phone_number: '+1555' }, { ok: true }, 'Alex'),
    null,
    'success is still silent',
  );
});
