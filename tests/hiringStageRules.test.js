'use strict';

/**
 * The pure rules behind the Bitrix stage proposals: what leaves for a model
 * (no SSN, no phone), what a conversation looks like to it, and which of its
 * answers may become a proposal. Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactForAi, extractPhones } = require('../lib/hiringStages/redact');
const conversation = require('../lib/hiringStages/conversation');
const { normaliseStages, verifyStageAnswer, isForwardMove, stageByName } = require('../lib/hiringStages/proposal');
const msg = require('../lib/hiringStages/messages');

test('AN SSN NEVER LEAVES — labelled, dashed or bare — and neither does a phone', () => {
  const text = 'could we please schedule his drug test\ntel number; +14045550134\naddress; Anderson SC\nssn; 455453402';
  const out = redactForAi(text);
  assert.doesNotMatch(out, /455453402|4045550134/);
  assert.match(out, /ssn; \[removed\]/);
  assert.match(out, /tel number; \[phone\]/);
  assert.match(out, /Anderson SC/, 'words stay');

  for (const [input, gone] of [
    ['SSN: 455-45-3402', '455-45-3402'],
    ['social security number 455 45 3402', '455 45 3402'],
    ['his number is 455-45-3402 ok', '455-45-3402'],
    ['DOB 01/02/1980', '01/02/1980'],
    ['CDL # A1234567', 'A1234567'],
    ['account 12345678901234', '12345678901234'],
    ['call (404) 555-0134', '555-0134'],
  ]) {
    assert.ok(!redactForAi(input).includes(gone), `${input} → ${redactForAi(input)}`);
  }
  assert.equal(redactForAi('3+ yrs of exp, 80 CPM, unit 1407'), '3+ yrs of exp, 80 CPM, unit 1407', 'short numbers stay');
});

test('phones are read as people type them; an SSN is never a phone', () => {
  assert.deepEqual(extractPhones('Patrick Donovan\n+1 (404) 555-0134\nready asap'), ['4045550134']);
  assert.deepEqual(extractPhones('(404) 555-0134 or 404.555.0199, again 4045550134'), ['4045550134', '4045550199']);
  assert.deepEqual(extractPhones('ssn; 455453402'), []);
  assert.deepEqual(extractPhones('ssn 4554534021'), [], 'a labelled number is an SSN even with a stray digit');
  assert.deepEqual(extractPhones('1-404-555-0134'), ['4045550134']);
  assert.deepEqual(extractPhones('unit 1407, 3 weeks OTR'), []);
});

const SAFETY = '900';
const m = (messageId, over = {}) => ({
  messageId, fromUserId: '500', fromName: 'Kim R', text: null, photos: [], documents: [],
  mediaGroupId: null, replyToMessageId: null, ...over,
});
const THREAD = [
  m(169, { mediaGroupId: 'g1', photos: [{ file_id: 'p' }], text: 'Company Driver - 80 CPM\nPHILLIPS SAMUEL JAHBARI\n(404) 555-0134' }),
  m(170, { mediaGroupId: 'g1', photos: [{ file_id: 'q' }] }),
  m(172, { fromUserId: SAFETY, fromName: 'Safety', text: 'CLH sent', replyToMessageId: 169 }),
  m(173, { text: 'Done', replyToMessageId: 172 }),
  m(174, { fromUserId: SAFETY, fromName: 'Safety', text: 'CLEAN', documents: [{ file_name: 'CLH PHILLIPS.pdf' }], replyToMessageId: 173 }),
  m(184, { text: 'schedule his drug test\nssn; 455453402', replyToMessageId: 169 }),
];

test('the transcript says who spoke, keeps the words, and leaves the SSN behind', () => {
  const t = conversation.buildTranscript(THREAD, { rootMessageId: 169, safetyUserIds: [SAFETY] });
  assert.match(t, /^\[1\] Recruiter post \(Kim R\): Company Driver - 80 CPM PHILLIPS SAMUEL JAHBARI \[phone\] \[photo\]/);
  assert.match(t, /Safety \(Safety\): CLH sent/);
  assert.match(t, /Recruiter \(Kim R\): Done/);
  assert.match(t, /CLEAN \[files: CLH PHILLIPS\.pdf\]/);
  assert.doesNotMatch(t, /455453402|555-0134/);
  assert.equal(conversation.hasReplies(THREAD, 169), true);
  assert.equal(conversation.hasReplies(THREAD.slice(0, 2), 169), false, 'a lone album is not a conversation');
  assert.deepEqual(conversation.candidatePhones(THREAD, { rootMessageId: 169, safetyUserIds: [SAFETY] }), ['4045550134']);
});

const STAGES = normaliseStages([
  { STATUS_ID: 'PREPARATION', NAME: 'CLEARINGHOUSE CHECK', SORT: '20' },
  { STATUS_ID: 'NEW', NAME: 'New', SORT: '10' },
  { STATUS_ID: 'EXECUTING', NAME: 'MVR + PSP CHECK', SORT: '30' },
  { STATUS_ID: 'FINAL_INVOICE', NAME: 'READY', SORT: '40' },
  { STATUS_ID: 'WON', NAME: 'Hired', SORT: '60', EXTRA: { SEMANTICS: 'S' } },
  { STATUS_ID: 'LOSE', NAME: 'Not approved', SORT: '70', EXTRA: { SEMANTICS: 'F' } },
]);
const searchable = conversation.searchableText(THREAD);
const verify = (parsed, currentStageId = 'PREPARATION') => verifyStageAnswer(parsed, { stages: STAGES, currentStageId, searchable });

test('stages come in pipeline order, with Bitrix\'s won/lost marks', () => {
  assert.deepEqual(STAGES.map((s) => s.id), ['NEW', 'PREPARATION', 'EXECUTING', 'FINAL_INVOICE', 'WON', 'LOSE']);
  assert.equal(STAGES.find((s) => s.id === 'LOSE').semantics, 'F');
  assert.equal(stageByName(STAGES, 'mvr + psp check').id, 'EXECUTING');
});

test('a verified forward move, quoting real words, becomes a proposal', () => {
  const out = verify({ move: true, stage_id: 'EXECUTING', driver_name: 'Samuel Phillips', evidence: 'CLEAN' });
  assert.equal(out.move, true);
  assert.equal(out.stage.name, 'MVR + PSP CHECK');
  assert.equal(out.driverName, 'Samuel Phillips');
});

test('EVERY WAY A MODEL COULD PROPOSE THE WRONG THING IS DROPPED', () => {
  const cases = [
    [null, 'no_answer'],
    [{ move: false }, 'no_change'],
    [{ move: true, stage_id: 'MADE_UP', evidence: 'CLEAN' }, 'unknown_stage'],
    [{ move: true, stage_id: 'PREPARATION', evidence: 'CLH sent' }, 'already_there'],
    [{ move: true, stage_id: 'NEW', evidence: 'CLH sent' }, 'backwards'],
    [{ move: true, stage_id: 'FINAL_INVOICE', evidence: 'Safety approved the driver' }, 'evidence_not_in_conversation'],
    [{ move: true, stage_id: 'FINAL_INVOICE', evidence: '' }, 'evidence_not_in_conversation'],
    [{ move: true, stage_id: 'EXECUTING', evidence: 'CLEAN', driver_name: 'Samuel Jones' }, 'name_not_in_conversation'],
  ];
  for (const [parsed, reason] of cases) {
    assert.deepEqual(verify(parsed), { move: false, reason }, JSON.stringify(parsed));
  }
});

test('a refusal may end a candidate from anywhere; a closed deal is never reopened', () => {
  const lose = STAGES.find((s) => s.id === 'LOSE');
  const ready = STAGES.find((s) => s.id === 'FINAL_INVOICE');
  assert.equal(isForwardMove(STAGES, 'EXECUTING', lose), true);
  assert.equal(isForwardMove(STAGES, 'WON', lose), false);
  assert.equal(isForwardMove(STAGES, 'LOSE', ready), false);
  assert.equal(isForwardMove(STAGES, null, STAGES[0]), true, 'no deal yet: any stage may be named');
});

test('the group message quotes, escapes, and carries the right buttons', () => {
  const p = {
    id: 7, driverName: '<b>Sam</b>', dealId: 12, dealTitle: 'Facebook Lead – Sam & Co', dealUrl: 'https://x.bitrix24.com/crm/deal/details/12/',
    fromStageName: 'CLEARINGHOUSE CHECK', toStageName: 'MVR + PSP CHECK', evidence: 'CLEAN',
  };
  const text = msg.moveText(p);
  assert.match(text, /move <b>&lt;b&gt;Sam&lt;\/b&gt;<\/b> to <b>MVR \+ PSP CHECK<\/b>\?/);
  assert.match(text, /Sam &amp; Co/);
  assert.match(text, /Why: “CLEAN”/);
  const kb = msg.moveKeyboard(7, p.toStageName).inline_keyboard[0];
  assert.deepEqual(kb.map((b) => b.callback_data), ['hst:ok:7', 'hst:no:7']);
  assert.ok(kb.every((b) => Buffer.byteLength(b.callback_data) <= 64));
  assert.match('hst:re:12', msg.CALLBACK_PATTERN);
  assert.doesNotMatch('hst:ok:12x', msg.CALLBACK_PATTERN);

  const ask = msg.createDealText({ ...p, dealId: null, recruiterUserId: '500', recruiterName: 'Kim R', driverPhone: '4045550134' });
  assert.match(ask, /no open deal found/);
  assert.match(ask, /<a href="tg:\/\/user\?id=500">Kim R<\/a>, please create the deal/);
  assert.deepEqual(msg.createDealKeyboard(9).inline_keyboard[0].map((b) => b.callback_data), ['hst:re:9', 'hst:no:9']);

  assert.match(msg.closedText(p, 'applied', { byName: 'Ann' }), /moved to <b>MVR \+ PSP CHECK<\/b> in Bitrix — Ann/);
  assert.match(msg.closedText(p, 'stale', { detail: 'READY' }), /is now at <b>READY<\/b>/);
});
