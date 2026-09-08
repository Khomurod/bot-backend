/**
 * The assigned recruiter chooses the WORDS, not just the number.
 *
 * These drive services/facebookLeadEventProcessor through the shared fake world
 * and pin the ordering the feature rests on: the Bitrix assignee is resolved
 * once, BEFORE the template is picked, and the same resolution is what sends.
 * The template-selection rules themselves are pinned in
 * tests/facebookLeadRecruiterMessages.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { EVENT, loadProcessor } = require('./helpers/leadProcessorHarness');


test('the recruiter is resolved ONCE, before the message is chosen', async () => {
  // Order matters twice over: the template depends on who was assigned, and a
  // second resolve would mean a second bounded Bitrix poll per lead.
  const { processor, telegram, calls, restore } = loadProcessor();
  try {
    await processor.processLeadEvent(EVENT, { telegram });

    assert.equal(calls.resolves.length, 1, 'exactly one Bitrix assignee lookup');
    assert.deepEqual(
      { bitrixId: calls.resolves[0].bitrixId, entity: calls.resolves[0].entity },
      { bitrixId: 'B-1', entity: 'lead' },
    );
    // …and that recruiter is what the template picker was asked about.
    assert.equal(calls.autoSmsArgs.length, 1);
    assert.deepEqual(calls.autoSmsArgs[0].recruiter, { id: 7, name: 'Jane Doe' });
    // The send reuses the SAME resolution, so the text leaves their number.
    assert.equal(calls.sends[0].resolved.recruiter.id, 7);
  } finally { restore(); }
});

test('an unresolvable recruiter still gets the global message on the shared number', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    resolvedRecruiter: { recruiter: null, assignedById: null, reason: 'unassigned' },
    autoSms: { isEnabled: true, template: 'Global {first_name}', settings: {}, ruleLabel: 'Fallback', repName: '' },
    senderResult: {
      smsResult: { ok: true, messageId: 'rc-shared' },
      via: 'shared',
      recruiter: null,
      recruiterId: null,
      assignedById: null,
      fromNumber: '+14704804679',
      fallbackReason: 'unassigned',
      fallbackNote: 'Bitrix had not assigned the lead yet — sent from the shared number.',
    },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.autoSmsArgs[0].recruiter, null);
    assert.equal(calls.sends[0].resolved.recruiter, null);
    assert.equal(calls.notices[0].fromNumber, '+14704804679');
  } finally { restore(); }
});

test('a recruiter template is rendered with THEIR name in {rep_name}', async () => {
  const { processor, telegram, calls, restore } = loadProcessor({
    resolvedRecruiter: { recruiter: { id: 11, name: 'Sofia' }, assignedById: 21, reason: 'assigned' },
    autoSms: {
      isEnabled: true,
      template: 'Hi {first_name}, this is {rep_name}.',
      settings: { rep_name: 'Tom' },
      ruleLabel: "Sofia's message",
      repName: 'Sofia',
    },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.sends[0].message, 'Hi Alex, this is Sofia.');
  } finally { restore(); }
});

test('an already-texted lead never reaches the recruiter lookup', async () => {
  // The duplicate guard runs first, so a re-driven historical lead costs no
  // Bitrix call and, more importantly, no second SMS.
  const { processor, telegram, calls, restore } = loadProcessor({
    existingLead: { id: 42, sms_from_number: '+14704804679' },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.deepEqual(calls.resolves, []);
    assert.deepEqual(calls.autoSmsArgs, []);
    assert.equal(calls.sends.length, 0);
  } finally { restore(); }
});

test('auto-SMS switched off costs no Bitrix assignee poll at all', async () => {
  // Resolving the assignee can wait out the full BITRIX24_ASSIGNEE_WAIT_MS
  // budget on an unassigned lead, and the webhook queue drains sequentially —
  // so a deployment that sends no auto-SMS would otherwise delay every later
  // event behind it for nothing. The master switch is read first.
  const { processor, telegram, calls, restore } = loadProcessor({
    autoMessageConfig: { settings: { id: 1, is_enabled: false }, rules: [] },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });

    assert.deepEqual(calls.resolves, [], 'no Bitrix lookup');
    assert.deepEqual(calls.autoSmsArgs, [], 'and no template resolution either');
    assert.equal(calls.sends.length, 0);
    assert.equal(calls.telegram.length, 2, 'the lead post, then the skip notice');
    assert.match(calls.telegram[1].text, /auto-SMS is disabled/);
  } finally { restore(); }
});

test('the auto-message configuration is read once and handed down', async () => {
  // Checking the master switch early must not cost a second query per lead.
  const { processor, telegram, calls, restore } = loadProcessor();
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.configLoads.length, 1);
    assert.deepEqual(calls.autoSmsArgs[0].config, { settings: { id: 1, is_enabled: true }, rules: [] });
  } finally { restore(); }
});

test('a deployment that never saved any auto-message settings still sends', async () => {
  // `settings: null` must not read as "disabled" — it is the shipped state
  // before anyone opens the panel, and those leads have always been texted.
  const { processor, telegram, calls, restore } = loadProcessor({
    autoMessageConfig: { settings: null, rules: [] },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });
    assert.equal(calls.resolves.length, 1);
    assert.equal(calls.sends.length, 1);
  } finally { restore(); }
});

test("a sender fallback keeps the assignee's name — the lead is still theirs", async () => {
  // Sofia owns the lead in Bitrix; her RingCentral send fails, so the text goes
  // out on the shared number. It still reads "this is Sofia", ON PURPOSE: she
  // is the one who will call, and signing it "Tom" would leave the driver
  // hearing from one person and called by another. The operator is told
  // separately — the fallback note rides into the Telegram thread.
  const { processor, telegram, calls, restore } = loadProcessor({
    resolvedRecruiter: { recruiter: { id: 11, name: 'Sofia' }, assignedById: 21, reason: 'assigned' },
    autoSms: {
      isEnabled: true,
      template: 'Hi {first_name}, this is {rep_name}.',
      settings: { rep_name: 'Tom' },
      ruleLabel: "Sofia's message",
      repName: 'Sofia',
    },
    senderResult: {
      smsResult: { ok: true, messageId: 'rc-shared' },
      via: 'shared',
      recruiter: null,
      recruiterId: null,
      assignedById: 21,
      fromNumber: '+14704804679',
      fallbackReason: 'recruiter_auth_failed',
      fallbackNote: 'Sofia could not authenticate with RingCentral — sent from the shared number.',
    },
  });
  try {
    await processor.processLeadEvent(EVENT, { telegram });

    assert.equal(calls.sends[0].message, 'Hi Alex, this is Sofia.');
    assert.equal(calls.notices[0].fromNumber, '+14704804679', 'from the shared number…');
    assert.match(calls.notices[0].senderNote, /could not authenticate/, '…and the operator is told why');
  } finally { restore(); }
});
