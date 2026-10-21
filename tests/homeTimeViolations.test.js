'use strict';

/**
 * lib/homeTime/violations.js — reading a Bitrix pipeline 33 card, deciding which
 * violations still need a message, and the message itself. Pure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../lib/homeTime/violations');

const card = (over = {}) => ({
  ID: '4512',
  TITLE: 'John Potter',
  CATEGORY_ID: '33',
  STAGE_ID: 'C33:UC_HTEARLY',
  UF_CRM_HT_FROM: '2026-10-03T03:00:00+03:00',
  UF_CRM_HT_UNTIL: '',
  UF_CRM_HT_LAST_DAYS: '2',
  UF_CRM_HT_ROAD_BEFORE: '19',
  UF_CRM_HT_ALLOW: '4',
  ...over,
});

test('each violation stage says what it says; every other stage is silence', () => {
  assert.deepEqual(V.readViolationDeal(card()).violations, ['early']);
  assert.deepEqual(V.readViolationDeal(card({ STAGE_ID: 'C33:UC_HTREDFLAG' })).violations, ['overstay']);
  assert.deepEqual(V.readViolationDeal(card({ STAGE_ID: 'C33:UC_HTEARLYOVER' })).violations, ['early', 'overstay']);
  for (const stage of ['C33:UC_HTAGREED', 'C33:UC_ROADU4W', 'C33:UC_SUPERMAN', 'C33:LOSE']) {
    assert.equal(V.readViolationDeal(card({ STAGE_ID: stage })).reason, 'not_a_violation_stage', stage);
  }
  assert.equal(V.readViolationDeal(card({ CATEGORY_ID: '0' })).reason, 'not_a_violation_stage', 'another pipeline is not ours');
});

test('a card reads as the calendar date and the numbers the script wrote', () => {
  const deal = V.readViolationDeal(card());
  assert.equal(deal.ok, true);
  assert.equal(deal.dealId, 4512);
  assert.equal(deal.homeFrom, '2026-10-03', 'the date as written, not shifted by a timezone');
  assert.equal(deal.roadDays, 19);
  assert.equal(deal.homeDays, 2);
  assert.equal(deal.driverName, 'John Potter');
  assert.equal(V.readViolationDeal(card({ UF_CRM_HT_ROAD_BEFORE: '' })).roadDays, null, 'blank is unknown, never zero');
});

test('NO HOME-SINCE DATE, NO ALERT — never guessed', () => {
  assert.equal(V.readViolationDeal(card({ UF_CRM_HT_FROM: '' })).reason, 'no_home_from');
  assert.equal(V.readViolationDeal(card({ UF_CRM_HT_FROM: 'soon' })).reason, 'no_home_from');
  assert.equal(V.readViolationDeal({ STAGE_ID: 'C33:UC_HTEARLY' }).reason, 'no_deal_id');
});

test('EARLY, later EARLY & OVERSTAYED: only the overstay is new', () => {
  assert.deepEqual(V.violationsToPost(['early', 'overstay'], ['early']), ['overstay']);
  assert.deepEqual(V.violationsToPost(['early', 'overstay'], []), ['early', 'overstay']);
  assert.deepEqual(V.violationsToPost(['early'], ['early']), []);
  assert.deepEqual(V.violationsToPost(['overstay'], ['early']), ['overstay']);
});

test('the idempotency key is deal + home stay + violation', () => {
  assert.equal(V.violationKey({ dealId: '4512', homeFrom: '2026-10-03', violation: 'early' }), '4512:2026-10-03:early');
  assert.notEqual(
    V.violationKey({ dealId: 4512, homeFrom: '2026-10-03', violation: 'early' }),
    V.violationKey({ dealId: 4512, homeFrom: '2026-11-07', violation: 'early' }),
    'the next home stay is a new alert'
  );
});

test('the message: one violation, its facts against the policy, accounting tagged, no dollar amount', () => {
  const text = V.buildViolationMessage({
    driverName: 'John Potter', violations: ['early'], roadDays: 19, homeDays: 2,
    homeFrom: '2026-10-03', mentions: ['@cameron_acc', '@Ellaaccounting'],
  });
  assert.match(text, /^🚨 <b>Home-time policy violation — driver must be charged<\/b>/);
  assert.match(text, /Driver: <b>JOHN POTTER<\/b>/);
  assert.match(text, /Violation: <b>Came home early<\/b> — 19 days on the road \(policy: 28\)/);
  assert.match(text, /Home since: <b>Oct 3<\/b>/);
  assert.match(text, /@cameron_acc @Ellaaccounting please charge this driver for violating Wenze's home-time policy\./);
  assert.doesNotMatch(text, /\$/);
});

test('the message: overstay, and both at once', () => {
  const over = V.buildViolationMessage({ driverName: 'A B', violations: ['overstay'], homeDays: 7, homeFrom: '2026-10-03' });
  assert.match(over, /Violation: <b>Overstayed<\/b> — 7 days at home \(policy: 4\)/);
  const both = V.buildViolationMessage({
    driverName: 'A B', violations: ['early', 'overstay'], roadDays: 12, homeDays: 9, homeFrom: '2026-10-03',
  });
  assert.match(both, /Violations:\n• <b>Came home early<\/b> — 12 days on the road[^\n]*\n• <b>Overstayed<\/b> — 9 days at home/);
});

test('the message survives missing numbers and hostile names', () => {
  const text = V.buildViolationMessage({ driverName: '<script>', violations: ['early'], homeFrom: null });
  assert.match(text, /Driver: <b>&lt;SCRIPT&gt;<\/b>/);
  assert.match(text, /Violation: <b>Came home early<\/b>\n/);
  assert.doesNotMatch(text, /Home since/);
  assert.throws(() => V.buildViolationMessage({ violations: [] }), /no violation/);
});

test('the buttons, and the pattern that answers them', () => {
  const kb = V.keyboardFor(77);
  assert.deepEqual(kb.inline_keyboard[0].map((b) => b.callback_data), ['htv:c:77', 'htv:n:77']);
  assert.deepEqual('htv:n:77'.match(V.CALLBACK_PATTERN).slice(1), ['n', '77']);
  assert.equal('htv:x:77'.match(V.CALLBACK_PATTERN), null);
});

test('the footer once accounting answered', () => {
  const at = '2026-10-21T15:00:00Z';
  assert.match(V.decisionFooter({ decision: 'charged', decidedByName: '@cameron_acc', decidedAt: at }),
    /✅ <b>Charged<\/b> by @cameron_acc on Oct 21/);
  assert.match(V.decisionFooter({ decision: 'not_charging', decidedByName: '@Ellaaccounting', decidedAt: at }),
    /❌ <b>Not charging<\/b> — decided by @Ellaaccounting on Oct 21\nReason: waiting for @Ellaaccounting to reply/);
  assert.match(V.decisionFooter({
    decision: 'not_charging', decidedByName: 'Ella A', decidedAt: at, reason: 'family <emergency>',
  }), /decided by Ella A on[^\n]*\nReason: family &lt;emergency&gt;/, 'no username: the name, never a made-up handle');
});

test('the webhook secret: constant time, and an unset secret matches nothing', () => {
  assert.equal(V.tokensMatch('s3cret', 's3cret'), true);
  assert.equal(V.tokensMatch('s3cre', 's3cret'), false);
  assert.equal(V.tokensMatch('', ''), false);
  assert.equal(V.tokensMatch('anything', undefined), false);
});

test('the deal id, in the shapes a Bitrix robot sends it', () => {
  assert.equal(V.dealIdFromWebhook({ 'document_id[2]': 'DEAL_4512' }), 4512);
  assert.equal(V.dealIdFromWebhook({ document_id: ['crm', 'CCrmDocumentDeal', 'DEAL_4512'] }), 4512);
  assert.equal(V.dealIdFromWebhook({}, { deal_id: '4512' }), 4512);
  assert.equal(V.dealIdFromWebhook({ deal_id: 'LEAD_9' }), null);
  assert.equal(V.dealIdFromWebhook({}), null);
});

test('what Bitrix must have: the five fields and the three stages', () => {
  assert.deepEqual(V.missingFieldCodes({ UF_CRM_HT_FROM: {}, UF_CRM_HT_LAST_DAYS: {} }),
    ['UF_CRM_HT_UNTIL', 'UF_CRM_HT_ROAD_BEFORE', 'UF_CRM_HT_ALLOW']);
  assert.deepEqual(V.missingStageIds([{ STATUS_ID: 'C33:UC_HTEARLY' }, { STATUS_ID: 'C33:UC_HTREDFLAG' }]),
    ['C33:UC_HTEARLYOVER']);
  assert.deepEqual(V.missingStageIds(V.VIOLATION_STAGE_IDS.map((id) => ({ STATUS_ID: id }))), []);
});
