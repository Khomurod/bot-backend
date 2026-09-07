/**
 * WHOSE number a Facebook lead is texted from.
 *
 * The business rule: the recruiter Bitrix24 assigned the lead to sends the
 * text, so the driver's reply lands in that recruiter's phone. Everything else
 * here is about the guarantee that comes with it — a lead is NEVER left
 * un-texted. Every way the assigned sender can be unavailable falls back to the
 * shared company number, and every fallback an operator could fix says so out
 * loud, because an expired RingCentral login is otherwise indistinguishable
 * from success.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const RC_PATH = require.resolve('../database/ringcentral');
const BITRIX_PATH = require.resolve('../services/bitrix24Service');
const SMS_PATH = require.resolve('../services/ringCentralSmsService');
const SENDER_PATH = require.resolve('../services/facebookLeadSmsSender');

const JANE = {
  id: 7,
  name: 'Jane Doe',
  phone_number: '+15550001111',
  active: true,
  bitrix_user_id: 17,
  refresh_token_encrypted: 'enc',
};

/**
 * Load the sender with its three collaborators replaced. Everything the sender
 * touches is I/O, so the seams ARE the unit.
 */
function loadSender({
  recruiters = { 17: JANE },
  mapped = true,
  assignee = { assignedById: 17, accepted: true, attempts: 1 },
  recruiterSend = { ok: true, fromNumber: '+15550001111', messageId: 'rc-own' },
  sharedSend = { ok: true, fromNumber: '+14704804679', messageId: 'rc-shared' },
} = {}) {
  const calls = { shared: [], asRecruiter: [], assigneeArgs: [], mappedChecks: 0 };

  require.cache[RC_PATH] = {
    exports: {
      hasMappedSmsSenders: async () => { calls.mappedChecks += 1; return mapped; },
      getRecruiterByBitrixUserId: async (id) => recruiters[id] || null,
      recruiterCanSendSms: (row) => Boolean(row?.phone_number)
        && Boolean(row?.refresh_token_encrypted || row?.jwt_token_encrypted),
    },
  };
  require.cache[BITRIX_PATH] = {
    exports: {
      waitForCrmAssignee: async (args) => {
        calls.assigneeArgs.push(args);
        if (typeof assignee === 'function') return assignee(args);
        // Honour the caller's own acceptance test, as the real one does.
        if (assignee.assignedById != null && args.isAcceptable) {
          const ok = await args.isAcceptable(assignee.assignedById);
          return { ...assignee, accepted: ok, reason: ok ? undefined : 'not_acceptable' };
        }
        return assignee;
      },
    },
  };
  require.cache[SMS_PATH] = {
    exports: {
      sendSms: async (to, message) => { calls.shared.push({ to, message }); return sharedSend; },
      sendSmsAsRecruiter: async (recruiter, to, message) => {
        calls.asRecruiter.push({ recruiterId: recruiter.id, to, message });
        return typeof recruiterSend === 'function' ? recruiterSend() : recruiterSend;
      },
    },
  };
  delete require.cache[SENDER_PATH];
  const sender = require(SENDER_PATH);
  const restore = () => {
    delete require.cache[RC_PATH];
    delete require.cache[BITRIX_PATH];
    delete require.cache[SMS_PATH];
    delete require.cache[SENDER_PATH];
  };
  return { sender, calls, restore };
}

test('the assigned recruiter sends the text from their own number', async () => {
  const { sender, calls, restore } = loadSender();
  try {
    const result = await sender.sendLeadSms({
      phone: '+15559998888', message: 'Hi Alex', bitrixId: 42,
    });
    assert.equal(result.via, 'recruiter');
    assert.equal(result.recruiterId, 7);
    assert.equal(result.assignedById, 17);
    assert.equal(result.fromNumber, '+15550001111');
    assert.equal(result.smsResult.ok, true);
    assert.equal(result.fallbackReason, null);
    assert.equal(result.fallbackNote, null, 'nothing to warn about on the happy path');
    assert.deepEqual(calls.asRecruiter, [{ recruiterId: 7, to: '+15559998888', message: 'Hi Alex' }]);
    assert.deepEqual(calls.shared, [], 'the shared number is not touched');
  } finally { restore(); }
});

test('with nobody mapped, nothing changes: shared number, no Bitrix call, no delay', async () => {
  // The state of every deployment before an operator enters a Bitrix user id.
  const { sender, calls, restore } = loadSender({ mapped: false });
  try {
    const result = await sender.sendLeadSms({ phone: '+15559998888', message: 'Hi', bitrixId: 42 });
    assert.equal(result.via, 'shared');
    assert.equal(result.fallbackReason, 'no_mapped_recruiters');
    assert.equal(result.fallbackNote, null, 'an unconfigured deployment is not a problem to report');
    assert.equal(calls.mappedChecks, 1);
    assert.deepEqual(calls.assigneeArgs, [], 'Bitrix is never asked');
    assert.equal(calls.shared.length, 1);
  } finally { restore(); }
});

test('no CRM record means no assignee to find', async () => {
  const { sender, calls, restore } = loadSender();
  try {
    for (const bitrixId of [null, undefined, '']) {
      const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId });
      assert.equal(result.via, 'shared');
      assert.equal(result.fallbackReason, 'no_crm_record');
    }
    assert.equal(calls.mappedChecks, 0, 'and no database question either');
  } finally { restore(); }
});

test('an unassigned lead falls back, and says so', async () => {
  const { sender, calls, restore } = loadSender({
    assignee: { assignedById: null, accepted: false, attempts: 6, reason: 'not_acceptable' },
  });
  try {
    const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId: 42 });
    assert.equal(result.via, 'shared');
    assert.equal(result.fallbackReason, 'unassigned');
    assert.match(result.fallbackNote, /had not assigned/i);
    assert.equal(calls.shared.length, 1);
  } finally { restore(); }
});

test('an assignee who is not a recruiter falls back, and names the problem', async () => {
  const { sender, restore } = loadSender({ recruiters: {} });
  try {
    const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId: 42 });
    assert.equal(result.via, 'shared');
    assert.equal(result.fallbackReason, 'unmapped_assignee');
    assert.equal(result.assignedById, 17, 'who Bitrix picked is still reported');
    assert.match(result.fallbackNote, /not mapped to a recruiter/i);
  } finally { restore(); }
});

test('an inactive recruiter, or one with no credentials, is not a sender', async () => {
  for (const [label, row] of [
    ['inactive', { ...JANE, active: false }],
    ['no credentials', { ...JANE, refresh_token_encrypted: null, jwt_token_encrypted: null }],
    ['no number', { ...JANE, phone_number: '' }],
  ]) {
    const { sender, calls, restore } = loadSender({ recruiters: { 17: row } });
    try {
      const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId: 42 });
      assert.equal(result.via, 'shared', label);
      assert.equal(result.fallbackReason, 'unmapped_assignee', label);
      assert.equal(calls.asRecruiter.length, 0, label);
      assert.equal(calls.shared.length, 1, label);
    } finally { restore(); }
  }
});

test('a broken RingCentral login falls back AND is reported by name', async () => {
  const { sender, calls, restore } = loadSender({
    recruiterSend: { ok: false, reason: 'recruiter_auth_failed', detail: 'invalid_grant' },
  });
  try {
    const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId: 42 });
    assert.equal(result.via, 'shared');
    assert.equal(result.fallbackReason, 'recruiter_auth_failed');
    assert.match(result.fallbackNote, /^Jane Doe /, 'the note names who to go fix');
    assert.match(result.fallbackNote, /re-connect/i);
    assert.equal(calls.asRecruiter.length, 1, 'their number was tried first');
    assert.equal(calls.shared.length, 1, 'and the lead still got a text');
  } finally { restore(); }
});

test('a rejected send from their number is a different, still-reported failure', async () => {
  const { sender, restore } = loadSender({
    recruiterSend: { ok: false, reason: 'http_400', detail: 'Not registered for SMS' },
  });
  try {
    const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId: 42 });
    assert.equal(result.fallbackReason, 'recruiter_send_failed');
    assert.match(result.fallbackNote, /refused the send/i);
  } finally { restore(); }
});

test('a thrown collaborator is a fallback, not a lost lead', async () => {
  // A database hiccup arrives AFTER the Telegram post and the CRM record, so
  // throwing here would cost the driver their text and re-run the whole event.
  const { sender, calls, restore } = loadSender({
    assignee: () => { throw new Error('connect ECONNREFUSED'); },
  });
  try {
    const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId: 42 });
    assert.equal(result.via, 'shared');
    assert.equal(result.fallbackReason, 'sender_lookup_failed');
    assert.match(result.fallbackNote, /Could not look up/i);
    assert.equal(calls.shared.length, 1);
  } finally { restore(); }
});

test('sendSmsAsRecruiter rejecting the promise is handled too', async () => {
  const { sender, restore } = loadSender({
    recruiterSend: () => { throw new Error('socket hang up'); },
  });
  try {
    const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId: 42 });
    assert.equal(result.via, 'shared');
    assert.equal(result.fallbackReason, 'recruiter_auth_failed');
  } finally { restore(); }
});

test('a failed shared send is still reported as a failure, not a success', async () => {
  const { sender, restore } = loadSender({
    mapped: false,
    sharedSend: { ok: false, reason: 'not_configured' },
  });
  try {
    const result = await sender.sendLeadSms({ phone: '+1555', message: 'Hi', bitrixId: 42 });
    assert.equal(result.smsResult.ok, false);
    assert.equal(result.fromNumber, null, 'nothing sent means no sending number');
  } finally { restore(); }
});

test('the acceptance test handed to Bitrix is the real "can this person send"', async () => {
  const { sender, calls, restore } = loadSender();
  try {
    await sender.resolveLeadSmsRecruiter({ bitrixId: 42 });
    const [args] = calls.assigneeArgs;
    assert.equal(typeof args.isAcceptable, 'function');
    assert.equal(await args.isAcceptable(17), true, 'a mapped, credentialed recruiter');
    assert.equal(await args.isAcceptable(999), false, 'an unknown Bitrix user');
    assert.equal(await args.isAcceptable(null), false, 'nobody assigned');
  } finally { restore(); }
});

test('describeSenderFallback stays quiet about states nobody can act on', async () => {
  const { sender, restore } = loadSender();
  try {
    for (const reason of ['no_mapped_recruiters', 'no_crm_record', null, undefined, 'made_up']) {
      assert.equal(sender.describeSenderFallback({ reason }), null, String(reason));
    }
    for (const reason of sender.ACTIONABLE_FALLBACKS) {
      assert.equal(typeof sender.describeSenderFallback({ reason }), 'string', reason);
    }
  } finally { restore(); }
});
