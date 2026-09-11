'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { considerReply, CAPABILITY } = require('../services/recruiting/afterHoursReply');
const { inQuietHours, buildPrompt, validateShape } = require('../services/recruiting/afterHoursCompose');

const OFFICE = [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }];
// Friday 2026-09-11, 19:30 Chicago — office shut, before the 21:00 quiet hour.
const AFTER_HOURS = '2026-09-12T00:30:00Z';
// Friday 2026-09-11, 10:00 Chicago — office open.
const WORKING = '2026-09-11T15:00:00Z';
// Saturday 2026-09-12, 03:00 Chicago — shut AND asleep.
const MIDDLE_OF_NIGHT = '2026-09-12T08:00:00Z';

const KNOWLEDGE = [
  { kind: 'fact', statement: 'Company driver pay is 77 cents per mile.' },
  { kind: 'fact', statement: 'Home time is every 3 weeks.' },
];

const THREAD = [
  { id: 1, source_type: 'outbound_auto', sms_body: 'Hi, this is Tom at Wenze. Looking for OTR work?', created_at: '2026-09-11T23:00:00Z' },
  { id: 2, source_type: 'inbound_rc', sms_body: 'Yes. What does it pay?', created_at: '2026-09-12T00:29:00Z' },
];

function harness(overrides = {}) {
  const calls = { sms: [], notices: [], posted: [], closed: [], replies: 0, refusals: [] };
  const conversation = {
    driverPhone: '+15551230000', leadName: 'Sam Rivera', recruiterId: 7,
    telegramChatId: -100123, status: 'active', repliesSent: 0, acknowledgedAt: null,
    ...(overrides.conversation || {}),
  };
  const deps = {
    hours: {
      getRecruitingHours: async () => ({
        timezone: 'America/Chicago',
        windows: OFFICE,
        aiAfterHoursEnabled: true,
        maxRepliesPerConversation: 4,
        quietStartLocal: '21:00',
        quietEndLocal: '08:00',
        ...(overrides.settings || {}),
      }),
    },
    conversations: {
      ensureConversation: async () => conversation,
      getConversation: async () => conversation,
      recordReply: async () => { calls.replies += 1; return conversation; },
      recordRefusal: async (_p, reason) => { calls.refusals.push(reason); return conversation; },
      markAcknowledged: async () => { conversation.acknowledgedAt = new Date().toISOString(); return conversation; },
      closeConversation: async (_p, args) => { calls.closed.push(args); return conversation; },
    },
    knowledge: { listActiveKnowledge: async () => (overrides.knowledge ?? KNOWLEDGE) },
    mirrors: { listSmsMirrorsByPhone: async () => (overrides.thread ?? THREAD) },
    rc: {
      getRecruiterById: async () => (overrides.recruiter === null
        ? null
        : { id: 7, name: 'Tom Robinson', phone_number: '+14704804679', ...(overrides.recruiter || {}) }),
      recruiterCanSendSms: () => overrides.canSend !== false,
    },
    sendSmsAsRecruiter: async (_r, to, text) => {
      calls.sms.push({ to, text });
      return overrides.smsFails ? { ok: false, reason: 'recruiter_auth_failed' } : { ok: true, messageId: 'rc-1' };
    },
    runCapability: overrides.runCapability
      || (async () => ({ parsed: { reply: 'Pay is 77 cents per mile. Do you have OTR experience?', handOff: false } })),
    isCapabilityEnabled: async () => overrides.capabilityOn !== false,
    notify: async (n) => { calls.notices.push(n); return { recorded: true }; },
    postToThread: async (args) => { calls.posted.push(args); return { ok: true }; },
  };
  return { deps, calls, conversation };
}

const LEAD = { driverPhone: '+15551230000', leadName: 'Sam Rivera', recruiterId: 7, telegramChatId: -100123 };

// ── when Wenze stays quiet ──────────────────────────────────────────────────

test('the master switch off means nothing happens, whatever the hour', async () => {
  const { deps, calls } = harness({ settings: { aiAfterHoursEnabled: false } });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'disabled');
  assert.strictEqual(calls.sms.length, 0);
});

test('during working hours the recruiter answers, not Wenze', async () => {
  const { deps, calls } = harness();
  const out = await considerReply({ ...LEAD, at: WORKING }, deps);
  assert.strictEqual(out.reason, 'within_working_hours');
  assert.strictEqual(calls.sms.length, 0);
});

test('with no hours configured the office is always open, so Wenze never speaks', async () => {
  const { deps, calls } = harness({ settings: { windows: [] } });
  const out = await considerReply({ ...LEAD, at: MIDDLE_OF_NIGHT }, deps);
  assert.strictEqual(out.reason, 'no_hours_configured');
  assert.strictEqual(calls.sms.length, 0);
});

test('nobody is texted in the middle of the night', async () => {
  const { deps, calls } = harness();
  const out = await considerReply({ ...LEAD, at: MIDDLE_OF_NIGHT }, deps);
  assert.strictEqual(out.reason, 'quiet_hours');
  assert.strictEqual(calls.sms.length, 0);
});

test('the responsibility switch is honoured', async () => {
  const { deps, calls } = harness({ capabilityOn: false });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'capability_off');
  assert.strictEqual(calls.sms.length, 0);
});

test('a conversation a person took back is not resumed', async () => {
  const { deps, calls } = harness({ conversation: { status: 'handed_off' } });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'conversation_handed_off');
  assert.strictEqual(calls.sms.length, 0);
});

test('a recruiter who replied after Wenze takes the conversation back', async () => {
  const thread = [...THREAD,
    { id: 3, source_type: 'outbound_ai', sms_body: 'Pay is 77 cents per mile.', created_at: '2026-09-12T00:29:30Z' },
    { id: 4, source_type: 'outbound_recruiter', sms_body: 'Tom here, happy to talk.', created_at: '2026-09-12T00:29:45Z' },
    { id: 5, source_type: 'inbound_rc', sms_body: 'Great, thanks.', created_at: '2026-09-12T00:30:00Z' }];
  const { deps, calls } = harness({ thread });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'recruiter_took_over');
  assert.strictEqual(calls.sms.length, 0);
  assert.strictEqual(calls.closed[0].status, 'handed_off');
});

test('with no recruiter able to send, nothing goes out in anybody\'s name', async () => {
  const { deps, calls } = harness({ canSend: false });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'no_recruiter_can_send');
  assert.strictEqual(calls.sms.length, 0);
});

// ── the core safety property ────────────────────────────────────────────────

test('WITH NOTHING APPROVED, WENZE ANSWERS NOTHING — and says so to a human', async () => {
  const { deps, calls } = harness({ knowledge: [] });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);

  assert.strictEqual(out.reason, 'no_approved_knowledge');
  // The candidate is not left in silence: one fixed line, no facts in it.
  assert.strictEqual(calls.sms.length, 1);
  assert.match(calls.sms[0].text, /a recruiter will get back to you/i);
  assert.ok(!/\d\d/.test(calls.sms[0].text), 'the fixed line states no figures');
  // And somebody is told WHY a candidate went unanswered.
  assert.strictEqual(calls.notices.length, 1);
  assert.match(calls.notices[0].reason, /Teach Wenze/);
});

test('a model naming a figure nobody approved is refused whole, not edited', async () => {
  const { deps, calls } = harness({
    runCapability: async () => ({ parsed: { reply: 'Pay starts at 92 cents per mile here.', handOff: false } }),
  });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);

  assert.strictEqual(out.reason, 'refused_by_guard');
  assert.match(out.refusal, /unapproved_figure/);
  assert.strictEqual(calls.sms.length, 1, 'only the fixed acknowledgement goes out');
  assert.ok(!calls.sms[0].text.includes('92'), 'the refused claim never reaches the candidate');
  assert.strictEqual(calls.refusals.length, 1, 'the refusal is counted against the conversation');
});

test('a model promising something is refused', async () => {
  const { deps, calls } = harness({
    runCapability: async () => ({ parsed: { reply: 'I can guarantee you a truck when you start.', handOff: false } }),
  });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'refused_by_guard');
  assert.match(out.refusal, /commitment/);
  assert.ok(!calls.sms.some((s) => /guarantee/i.test(s.text)));
});

test('with AI unavailable the candidate still hears something, once', async () => {
  const { deps, calls, conversation } = harness({
    runCapability: async () => { throw new Error('AI is switched off'); },
  });
  const first = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(first.reason, 'ai_unavailable');
  assert.strictEqual(first.acknowledged, true);
  assert.strictEqual(calls.sms.length, 1);

  // Second inbound message on the same conversation: no second acknowledgement.
  // Somebody told twice that a person will be in touch has learned nobody is.
  assert.ok(conversation.acknowledgedAt);
  const second = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(second.acknowledged, false);
  assert.strictEqual(calls.sms.length, 1, 'still one');
});

test('a malformed model answer is treated as no answer', async () => {
  const { deps } = harness({ runCapability: async () => ({ parsed: { notAReply: true } }) });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'ai_bad_shape');
});

// ── the working case ────────────────────────────────────────────────────────

test('an approved answer is sent as the recruiter and mirrored into their thread', async () => {
  const { deps, calls } = harness();
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);

  assert.strictEqual(out.sent, true);
  assert.strictEqual(calls.sms.length, 1);
  assert.match(calls.sms[0].text, /77 cents per mile/);
  assert.strictEqual(calls.replies, 1);
  // The recruiter must be able to read what went out in their name.
  assert.strictEqual(calls.posted.length, 1);
  assert.strictEqual(calls.posted[0].telegramChatId, -100123);
  assert.strictEqual(calls.posted[0].text, calls.sms[0].text);
});

test('the model is shown the approved statements and the thread, and told the rules', async () => {
  let prompt = null;
  const { deps } = harness({
    runCapability: async (args) => {
      prompt = args.userText;
      assert.strictEqual(args.capability, CAPABILITY, 'the call names its responsibility');
      assert.strictEqual(args.expects, 'json');
      assert.strictEqual(typeof args.validate, 'function', 'the router gets the validator by its own name');
      return { parsed: { reply: 'Pay is 77 cents per mile. Do you have OTR experience?', handOff: false } };
    },
  });
  await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.match(prompt, /77 cents per mile/, 'the approved facts are in the prompt');
  assert.match(prompt, /What does it pay\?/, 'so is the candidate question');
  assert.match(prompt, /NEVER promise, guarantee, approve, waive/);
});

test('an SMS failure is reported and not counted as a reply', async () => {
  const { deps, calls } = harness({ smsFails: true });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'sms_failed');
  assert.strictEqual(calls.replies, 0);
  assert.strictEqual(calls.posted.length, 0, 'nothing is mirrored that never went out');
});

test('a model asking for a person hands the conversation over', async () => {
  const { deps, calls } = harness({
    runCapability: async () => ({
      parsed: { reply: 'A recruiter can go through that with you during working hours.', handOff: true, handOffReason: 'wants to negotiate' },
    }),
  });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.sent, true);
  assert.strictEqual(out.handOff, true);
  assert.strictEqual(calls.closed[0].status, 'handed_off');
  assert.match(calls.notices[0].reason, /negotiate/);
});

test('the reply cap stops Wenze, tells the candidate once, and calls a human', async () => {
  const { deps, calls } = harness({ conversation: { repliesSent: 4 } });
  const out = await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  assert.strictEqual(out.reason, 'reply_cap');
  assert.strictEqual(calls.replies, 0);
  assert.strictEqual(calls.closed[0].status, 'stopped');
  assert.match(calls.notices[0].reason, /reply limit/);
});

test('a notice about a candidate never asks for an employment decision', async () => {
  const { deps, calls } = harness({ conversation: { repliesSent: 4 } });
  await considerReply({ ...LEAD, at: AFTER_HOURS }, deps);
  const notice = calls.notices[0];
  assert.match(notice.action, /recruiter should pick this up/i);
  const whole = JSON.stringify(notice);
  for (const word of ['reject', 'hire', 'disqualif', 'terminate']) {
    assert.ok(!new RegExp(word, 'i').test(whole), `a notice must not say "${word}"`);
  }
});

// ── the small pure pieces ───────────────────────────────────────────────────

test('quiet hours wrap around midnight', () => {
  const q = { quietStartLocal: '21:00', quietEndLocal: '08:00' };
  assert.strictEqual(inQuietHours(q, '22:30'), true);
  assert.strictEqual(inQuietHours(q, '03:00'), true);
  assert.strictEqual(inQuietHours(q, '19:30'), false);
  assert.strictEqual(inQuietHours(q, '08:00'), false, 'the quiet period ends at 08:00');
});

test('quiet hours off means start equal to end', () => {
  assert.strictEqual(inQuietHours({ quietStartLocal: '00:00', quietEndLocal: '00:00' }, '03:00'), false);
});

test('the prompt fences the approved information off explicitly', () => {
  const prompt = buildPrompt({
    knowledgeText: 'pay is 77 cpm', threadText: 'Candidate: hi', recruiterName: 'Tom', companyName: 'Wenze',
  });
  assert.match(prompt, /=== The ONLY information you may state as fact ===/);
  assert.match(prompt, /=== end of approved information ===/);
});

test('the shape validator refuses anything without reply text', () => {
  assert.strictEqual(validateShape(null, { reply: 'hello there friend' }), true);
  assert.ok(validateShape(null, {}).message);
  assert.ok(validateShape(null, { reply: '   ' }).message);
  assert.ok(validateShape(null, null).message);
});
