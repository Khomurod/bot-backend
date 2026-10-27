'use strict';

/**
 * services/metaCrm/stageEvents.js — which Bitrix stage says what to Meta, and
 * which deals are reported at all. Pure; no database, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../services/metaCrm/stageEvents');

const NOW = Date.parse('2026-10-27T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const deal = (over = {}) => ({
  ID: '5603', LEAD_ID: '1837', CATEGORY_ID: '0', STAGE_ID: 'EXECUTING',
  MOVED_TIME: '2026-10-27T16:13:03+03:00', DATE_MODIFY: '2026-10-27T16:13:03+03:00', ...over,
});

test("the owner's mapping: four qualified stages, Hired, Lost — and nothing else", () => {
  assert.equal(S.eventForStage('EXECUTING'), 'Qualified');
  assert.equal(S.eventForStage('UC_PBR3LM'), 'Qualified');
  assert.equal(S.eventForStage('UC_DISPATCH'), 'Qualified');
  assert.equal(S.eventForStage('UC_SAFETY'), 'Qualified');
  assert.equal(S.eventForStage('WON'), 'Converted');
  assert.equal(S.eventForStage('LOSE'), 'Lost');
  for (const silent of ['NEW', 'PREPARATION', 'APOLOGY', 'C33:UC_HTEARLY', '', null, undefined, 'toString', '__proto__']) {
    assert.equal(S.eventForStage(silent), null, `${silent} reports nothing`);
  }
});

test('a deal is matched to its Facebook lead through LEAD_ID, or its own ID when leads are created as deals', () => {
  assert.equal(S.sourceRecordId(deal(), 'lead'), '1837');
  assert.equal(S.sourceRecordId(deal(), 'deal'), '5603');
  assert.equal(S.sourceRecordId(deal({ LEAD_ID: null }), 'lead'), null, 'a deal nobody converted from a lead');
  assert.equal(S.sourceRecordId(deal({ LEAD_ID: '0' }), 'lead'), null);
});

test('planEvents keeps only reporting stages of pipeline 0, from Facebook leads, inside the seven days', () => {
  const leadgenBySourceId = new Map([['1837', '1668864698200916'], ['1801', '1234567890123'], ['1700', '999999999']]);
  const { plan, skipped } = S.planEvents({
    entity: 'lead',
    nowMs: NOW,
    leadgenBySourceId,
    deals: [
      deal(),
      deal({ ID: '5565', LEAD_ID: '1801', STAGE_ID: 'WON' }),
      deal({ ID: '5600', LEAD_ID: '1837', STAGE_ID: 'PREPARATION' }), // Contacting: silent
      deal({ ID: '5601', LEAD_ID: '9999', STAGE_ID: 'LOSE' }), // not a Facebook lead
      deal({ ID: '5602', LEAD_ID: '1700', STAGE_ID: 'LOSE', MOVED_TIME: new Date(NOW - 8 * DAY).toISOString() }),
      deal({ ID: '5604', LEAD_ID: '1837', CATEGORY_ID: '33', STAGE_ID: 'WON' }), // another pipeline
      deal({ ID: '5605', LEAD_ID: '1837', MOVED_TIME: 'garbage', DATE_MODIFY: null }),
    ],
  });
  assert.deepEqual(plan.map((p) => [p.dealId, p.leadgenId, p.eventName]), [
    [5603, '1668864698200916', 'Qualified'],
    [5565, '1234567890123', 'Converted'],
  ]);
  assert.deepEqual(skipped, { silent_stage: 2, not_facebook: 1, stale: 1, no_time: 1 });
});

test('the event time is when the deal MOVED, clamped to now, falling back to the last edit', () => {
  assert.equal(S.stageChangedAtMs(deal(), NOW), Date.parse('2026-10-27T13:13:03Z'));
  assert.equal(S.stageChangedAtMs(deal({ MOVED_TIME: null, DATE_MODIFY: '2026-10-26T10:00:00Z' }), NOW), Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(S.stageChangedAtMs(deal({ MOVED_TIME: '2026-10-28T10:00:00Z' }), NOW), NOW, 'a future time becomes now');
  assert.equal(S.stageChangedAtMs({}, NOW), null);
});

test('the Conversions API event carries the leadgen id and nothing personal', () => {
  const ev = S.buildCapiEvent({ leadgenId: '1668864698200916', eventName: 'Qualified', eventTime: '2026-10-27T13:13:03Z' });
  assert.deepEqual(ev, {
    event_name: 'Qualified',
    event_time: Math.floor(Date.parse('2026-10-27T13:13:03Z') / 1000),
    event_id: 'bitrix:1668864698200916:Qualified',
    action_source: 'system_generated',
    user_data: { lead_id: 1668864698200916 },
    custom_data: { event_source: 'crm', lead_event_source: 'Bitrix24' },
  });
  const huge = S.buildCapiEvent({ leadgenId: '123456789012345678901', eventName: 'Lost', eventTime: NOW });
  assert.equal(huge.user_data.lead_id, '123456789012345678901', 'too long for a JS number: sent as text, never rounded');
});

test('isLeadgenId accepts Meta ids only', () => {
  assert.equal(S.isLeadgenId('1668864698200916'), true);
  for (const bad of ['', null, 'abc', '12', 'msg-123@gmail.com']) assert.equal(S.isLeadgenId(bad), false);
});
