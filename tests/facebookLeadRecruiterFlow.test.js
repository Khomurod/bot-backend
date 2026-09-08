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
