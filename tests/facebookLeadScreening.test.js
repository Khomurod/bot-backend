'use strict';

/**
 * services/facebookLeadScreening — a lead whose own form answers rule them out
 * (the owner, 23 November 2026): which answers count, and how the Bitrix deal
 * is found, checked and closed as Lost with the reason — never a deal a person
 * already moved on, never twice, every attempt in Monitoring → Logs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../services/facebookLeadScreening/rules');
const { closeScreenedOutLead, TRIGGER } = require('../services/facebookLeadScreening/close');
const { handleScreenedOutLead, screenLead } = require('../services/facebookLeadScreening');

// The light-screen form's questions as Meta names them (form 1296243945998781).
const LIGHT = {
  cdl: 'do_you_have_a_valid_class_a_cdl?',
  otr: 'do_you_have_at_least_2_years_of_verifiable_otr_experience_with_your_class_a_cdl?',
  contract: 'this_is_a_1099_otr_position:_out_on_the_road_2+_weeks_at_a_time._are_you_ok_with_that?',
  record: 'does_your_driving_record_meet_all_of_these:_no_dui/dwi_in_the_last_5_years,_no_more_than_2_moving_violations_and_no_more_than_1_preventable_accident_in_the_last_3_years?',
  time: 'what_is_the_best_time_to_call_you?',
};
const answers = (over = {}) => ({
  full_name: 'Alex Driver',
  phone_number: '+15559998888',
  [LIGHT.cdl]: 'Yes',
  [LIGHT.otr]: 'Yes',
  [LIGHT.contract]: 'Yes',
  [LIGHT.record]: 'Yes',
  [LIGHT.time]: 'Morning',
  ...over,
});

// ── which answers rule a lead out ────────────────────────────────────────────

test('all Yes is not screened out; a No to any must-have question is, with that reason', () => {
  assert.deepEqual(rules.screenLeadAnswers(answers()), { screenedOut: false, failed: [] });
  const cases = [
    [LIGHT.cdl, 'no_cdl_a'], [LIGHT.otr, 'experience'], [LIGHT.contract, 'contract_1099'], [LIGHT.record, 'record'],
  ];
  for (const [key, reason] of cases) {
    const s = rules.screenLeadAnswers(answers({ [key]: 'No' }));
    assert.equal(s.screenedOut, true, key);
    assert.deepEqual(s.failed.map((f) => f.reason), [reason], key);
  }
});

test('the answer must be a plain No — Meta may send it in any case or with underscores; anything else is not a reason', () => {
  for (const no of ['No', 'no', 'NO', ' no ', 'no.']) {
    assert.equal(rules.screenLeadAnswers(answers({ [LIGHT.cdl]: no })).screenedOut, true, no);
  }
  for (const other of ['Yes', '', 'Not sure', 'none', 'Evening']) {
    assert.equal(rules.screenLeadAnswers(answers({ [LIGHT.cdl]: other })).screenedOut, false, other);
  }
});

test('several Nos: Bitrix gets the first reason in order (CDL, experience, record, 1099), the note names them all', () => {
  const s = rules.screenLeadAnswers(answers({ [LIGHT.contract]: 'No', [LIGHT.otr]: 'No', [LIGHT.cdl]: 'No' }));
  assert.deepEqual(s.failed.map((f) => f.reason), ['no_cdl_a', 'experience', 'contract_1099']);
  assert.equal(rules.primaryReason(s), 'no_cdl_a');
  assert.match(rules.dealComment(s, '1296243945998781'),
    /Facebook form 1296243945998781.*answered No to: a valid Class A CDL; 2\+ years of verifiable OTR experience; a 1099 OTR position/);
});

test('questions that are not must-haves, or are ambiguous, never rule anyone out', () => {
  const s = rules.screenLeadAnswers({
    'what_is_the_best_time_to_call_you?': 'no',
    'when_can_you_start?': 'no',
    'are_you_cdl_a_over_the_road_driver': 'no', // old form: No could mean either half
    'do_you_have_2_years_of_experience': 'no', // old form: not OTR-specific
    'are_you_23_years_of_age_or_older?': 'no',
    full_name: 'No',
  });
  assert.equal(s.screenedOut, false);
});

test('the group notice: who, which answers, what happened in Bitrix — and that no text was sent', () => {
  const screening = rules.screenLeadAnswers(answers({ [LIGHT.record]: 'No' }));
  const closed = rules.screenedOutNotice({ leadName: 'Alex Driver', screening, outcome: { closed: true, dealId: 8170 } });
  assert.match(closed, /Alex Driver is not a fit.*a driving record that meets the requirements/);
  assert.match(closed, /Closed as Lost in Bitrix \(deal 8170\)/);
  assert.match(closed, /No auto-SMS was sent/);
  assert.match(rules.screenedOutNotice({ screening, outcome: { already: true, dealId: 8170 } }), /already closed as Lost/);
  assert.match(rules.screenedOutNotice({ screening, outcome: { closed: false, why: 'the lead had not become a deal yet' } }),
    /Not closed in Bitrix automatically \(the lead had not become a deal yet\)/);
});

// ── closing the deal ─────────────────────────────────────────────────────────

function fakes({ deals = [[{ ID: '8170', STAGE_ID: 'NEW', CATEGORY_ID: '0' }]], updateAnswer = true, throwOn = null } = {}) {
  const calls = [];
  const attempts = [];
  let listCall = 0;
  const deps = {
    bitrix: async (method, params, opts) => {
      calls.push({ method, params, opts });
      if (throwOn === method) throw Object.assign(new Error(`Bitrix ${method}: boom`), { activityRecorded: true });
      if (method === 'crm.deal.list') { const rows = deals[Math.min(listCall, deals.length - 1)]; listCall += 1; return rows; }
      if (method === 'crm.deal.update') return updateAnswer;
      return 1;
    },
    recordAttempt: async (a) => { attempts.push(a); },
    sleep: async () => {},
  };
  return { deps, calls, attempts };
}

const NO_CDL = rules.screenLeadAnswers(answers({ [LIGHT.cdl]: 'No' }));
const args = (over = {}) => ({
  bitrixResult: { ok: true, bitrixId: 3640, entity: 'lead' },
  screening: NO_CDL,
  leadgenId: '1668864698200916',
  formId: '1296243945998781',
  leadName: 'Alex Driver',
  attempts: 3,
  intervalMs: 0,
  ...over,
});

test('the converted deal at New Lead is moved to Lost with the reason, a note is left, both writes carry an audit', async () => {
  const { deps, calls, attempts } = fakes();
  const res = await closeScreenedOutLead({ ...args(), deps });
  assert.deepEqual(res, { closed: true, dealId: 8170 });
  assert.deepEqual(calls[0].params.filter, { LEAD_ID: 3640 }, 'found by the LEAD_ID backlink');
  const update = calls.find((c) => c.method === 'crm.deal.update');
  assert.deepEqual(update.params.fields, { STAGE_ID: 'LOSE', UF_CRM_1769517906834: '123' });
  assert.equal(update.params.id, 8170);
  assert.equal(update.opts.audit.trigger, TRIGGER);
  assert.equal(update.opts.audit.actorKind, 'automatic');
  assert.deepEqual(update.opts.audit.change[0], { field: 'STAGE_ID', from: 'NEW', to: 'LOSE' });
  assert.equal(update.opts.audit.evidence.leadgenId, '1668864698200916');
  const note = calls.find((c) => c.method === 'crm.timeline.comment.add');
  assert.deepEqual([note.params.fields.ENTITY_ID, note.params.fields.ENTITY_TYPE], [8170, 'deal']);
  assert.doesNotMatch(note.params.fields.COMMENT, /Alex|5559998888/, 'no name or phone in the note');
  assert.equal(note.opts.audit.trigger, TRIGGER);
  assert.equal(attempts.length, 0, 'a done write is recorded by the client, not as an attempt');
});

test('Contacting counts as open too; the deal is asked for again until Bitrix has converted the lead', async () => {
  const { deps, calls } = fakes({ deals: [[], [], [{ ID: '8171', STAGE_ID: 'PREPARATION', CATEGORY_ID: '0' }]] });
  const res = await closeScreenedOutLead({ ...args(), deps });
  assert.deepEqual(res, { closed: true, dealId: 8171 });
  assert.equal(calls.filter((c) => c.method === 'crm.deal.list').length, 3);
});

test('no deal within the wait: nothing written, a failed attempt in the log, the reason returned', async () => {
  const { deps, calls, attempts } = fakes({ deals: [[]] });
  const res = await closeScreenedOutLead({ ...args(), deps });
  assert.deepEqual(res, { closed: false, why: 'the lead had not become a deal yet' });
  assert.equal(calls.some((c) => c.method === 'crm.deal.update'), false);
  assert.equal(attempts[0].result, 'failed');
  assert.deepEqual([attempts[0].targetType, attempts[0].targetId], ['lead', 3640]);
});

test('a deal a person already moved on is left alone — a safety check, nothing sent to Bitrix', async () => {
  for (const moved of [{ STAGE_ID: 'EXECUTING', CATEGORY_ID: '0' }, { STAGE_ID: 'C11:NEW', CATEGORY_ID: '11' }]) {
    const { deps, calls, attempts } = fakes({ deals: [[{ ID: '8170', ...moved }]] });
    // eslint-disable-next-line no-await-in-loop
    const res = await closeScreenedOutLead({ ...args(), deps });
    assert.equal(res.closed, false);
    assert.equal(calls.some((c) => c.method === 'crm.deal.update'), false, moved.STAGE_ID);
    assert.equal(attempts[0].result, 'refused');
  }
});

test('a deal already Lost (a re-driven event) is already done — never closed twice', async () => {
  const { deps, calls, attempts } = fakes({ deals: [[{ ID: '8170', STAGE_ID: 'LOSE', CATEGORY_ID: '0' }]] });
  const res = await closeScreenedOutLead({ ...args(), deps });
  assert.deepEqual(res, { closed: false, already: true, dealId: 8170 });
  assert.equal(calls.some((c) => c.method === 'crm.deal.update'), false);
  assert.equal(attempts[0].result, 'already_done');
});

test('Bitrix refusing or not confirming the change: not closed, no note, nothing thrown', async () => {
  const refused = fakes({ throwOn: 'crm.deal.update' });
  const a = await closeScreenedOutLead({ ...args(), deps: refused.deps });
  assert.equal(a.closed, false);
  assert.match(a.why, /Bitrix refused the change/);
  assert.equal(refused.calls.some((c) => c.method === 'crm.timeline.comment.add'), false);
  const unconfirmed = fakes({ updateAnswer: false });
  const b = await closeScreenedOutLead({ ...args(), deps: unconfirmed.deps });
  assert.deepEqual(b, { closed: false, dealId: 8170, why: 'Bitrix did not confirm the change' });
});

test('the deal lookup failing is a failed attempt, not a crash; no Bitrix record means no call at all', async () => {
  const down = fakes({ throwOn: 'crm.deal.list' });
  const res = await closeScreenedOutLead({ ...args(), deps: down.deps });
  assert.equal(res.closed, false);
  assert.equal(down.attempts[0].result, 'failed');
  const none = fakes();
  for (const bitrixResult of [null, { ok: false, reason: 'incomplete' }]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await closeScreenedOutLead({ ...args({ bitrixResult }), deps: none.deps });
    assert.deepEqual(r, { closed: false, why: 'the lead is not in Bitrix' });
  }
  assert.equal(none.calls.length, 0);
});

test('leads created as deals: the record IS the deal, read by its id', async () => {
  const { deps, calls } = fakes();
  const res = await closeScreenedOutLead({ ...args({ bitrixResult: { ok: true, bitrixId: 8170, entity: 'deal' } }), deps });
  assert.equal(res.closed, true);
  assert.deepEqual(calls[0].params.filter, { ID: 8170 });
});

// ── the step in the lead chain ───────────────────────────────────────────────

test('handleScreenedOutLead closes, then posts one line; a failing close or post never throws', async () => {
  const posted = [];
  const outcome = await handleScreenedOutLead({
    screening: NO_CDL, bitrixResult: { ok: true, bitrixId: 1 }, leadgenId: 'lg', formId: 'f', leadName: 'Alex Driver',
    announce: async (text) => { posted.push(text); },
    close: async () => ({ closed: true, dealId: 8170 }),
  });
  assert.deepEqual(outcome, { closed: true, dealId: 8170 });
  assert.match(posted[0], /Alex Driver is not a fit.*\n.*deal 8170.*\nNo auto-SMS was sent/s);

  const quiet = await handleScreenedOutLead({
    screening: NO_CDL, bitrixResult: null, leadgenId: 'lg', leadName: null,
    announce: async () => { throw new Error('Telegram down'); },
    close: async () => { throw new Error('boom'); },
  });
  assert.equal(quiet.closed, false);
  assert.match(quiet.why, /boom/);
});

test('screenLead is the rules while switched on (config/facebookLeadScreening.json)', () => {
  assert.equal(screenLead(answers({ [LIGHT.otr]: 'No' })).screenedOut, true);
  assert.equal(screenLead(answers()).screenedOut, false);
});
