'use strict';

/**
 * Every attempt is its own entry (owner, 14 November 2026, decision c) — also
 * the ones that end BEFORE their write: a safety check saying no (nothing is
 * sent to Bitrix), or the read before the write getting no answer. Through the
 * REAL default dependencies (tests/helpers/activityLogFakes.js); names are
 * made up.
 *
 *   - a safety check's refusal is `refused` with `safetyCheck`, and never
 *     counts toward the owner's notice;
 *   - no answer is `failed`, never `refused` (the status sync once logged a
 *     timed-out re-read as refused);
 *   - a write the client recorded is never recorded twice by its caller.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fake, reset, settled, syncWithRealDeps,
} = require('./helpers/activityLogFakes');

const press = () => require('../services/boardBitrix/buttons').handleBoardBitrixButton({
  data: 'bbx:5:0', chatId: -1001, messageId: 42, telegramUserId: 777, fromName: 'Dina Dispatcher', fromIsBot: false,
});

test('the status sync: a re-read that gets no answer is FAILED, not refused, and counts toward the notice', async () => {
  reset();
  fake.fail['crm.deal.get'] = 'timeout';
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await syncWithRealDeps();
    // eslint-disable-next-line no-await-in-loop
    await settled();
  }
  assert.equal(fake.logged.length, 3);
  for (const e of fake.logged) {
    assert.equal(e.result, 'failed');
    assert.equal(e.safetyCheck, false);
    assert.match(e.error, /did not answer crm\.deal\.get/);
  }
  assert.equal(fake.notices.length, 1);
  assert.match(fake.notices[0].lines.join(' '), /Bitrix did not answer or failed/);
});

test('a Board ↔ Bitrix press whose read gets no answer is an entry with the presser — then the person is told', async () => {
  reset();
  fake.fail['crm.deal.get'] = 'timeout';
  await press();
  assert.match(fake.said.map((s) => s.text).join(' '), /Bitrix did not answer — nothing was changed/);
  assert.equal(fake.logged.length, 1);
  const e = fake.logged[0];
  assert.deepEqual([e.action, e.result, e.safetyCheck, e.actorKind, e.actorTelegramId, e.trigger],
    ['deal.stage', 'failed', false, 'person_button', 777, 'board_bitrix.button']);
  assert.equal(e.targetId, '321');
});

test('a Board ↔ Bitrix press refused because the layout is not proven is an entry (a safety check)', async () => {
  reset();
  fake.settings = { schemaSource: 'static_fallback', schemaMapping: null };
  await press();
  assert.equal(fake.logged.length, 1);
  assert.deepEqual([fake.logged[0].result, fake.logged[0].safetyCheck], ['refused', true]);
  assert.match(fake.logged[0].error, /layout is not proven/);
  await settled();
  assert.equal(fake.notices.length, 0);
});

test('a Board ↔ Bitrix write Bitrix refuses is ONE entry — the client\'s, never again by the caller', async () => {
  reset();
  fake.fail['crm.deal.update'] = 'refuse';
  await press();
  assert.equal(fake.logged.length, 1);
  assert.deepEqual([fake.logged[0].result, fake.logged[0].safetyCheck, fake.logged[0].actorKind], ['refused', false, 'person_button']);
});

test('a hiring Move whose read gets no answer is an entry; a refused Move write is one entry', async () => {
  reset();
  fake.deals[321] = {
    ID: '321', TITLE: 'Ann Lee', STAGE_ID: 'C5:NEW', CATEGORY_ID: '5', CLOSED: 'N',
  };
  const { handleStageButton } = require('../services/hiringStages/actions');
  const movePress = () => handleStageButton({
    action: 'ok', proposalId: 11, chatId: '-100', from: { id: 42, first_name: 'Rita', last_name: 'Recruiter' },
  }, { getSettings: async () => ({ enabled: true, stageProposalsEnabled: true, chatId: '-100' }), telegram: {} });

  fake.fail['crm.deal.get'] = 'timeout';
  assert.match((await movePress()).text, /Bitrix did not answer/);
  assert.equal(fake.logged.length, 1);
  assert.deepEqual([fake.logged[0].action, fake.logged[0].result, fake.logged[0].actorTelegramId, fake.logged[0].trigger],
    ['deal.stage', 'failed', 42, 'hiring_stage.move']);

  fake.logged.length = 0;
  fake.fail = { 'crm.deal.update': 'refuse' };
  await movePress();
  assert.equal(fake.logged.length, 1, 'the client recorded the refused write; the press did not add a second');
  assert.equal(fake.logged[0].result, 'refused');
});

test('a home-time card with no match is an entry (a safety check); a search with no answer is failed', async () => {
  reset();
  fake.deals = {};
  const { moveCard } = require('../services/homeTime/ownViolations');
  // The REAL pass's dependencies: the recorder must be among them.
  const deps = require('../services/homeTime/violationAlerts').defaultDeps();
  const stay = { homeFrom: '2026-11-01', homeDays: 6, roadDays: 20 };
  const card = await moveCard(stay, 'John Smith', ['early'], deps, { groupId: 3, violationIds: [91] });
  assert.match(card.note, /no Bitrix card/);
  assert.equal(fake.logged.length, 1);
  const e = fake.logged[0];
  assert.deepEqual([e.trigger, e.actorKind, e.result, e.safetyCheck, e.targetId], ['home_time.violation_card', 'automatic', 'refused', true, null]);
  assert.equal(e.targetLabel, 'John Smith', 'the name is the label — taken out after 60 days');

  fake.logged.length = 0;
  fake.fail['crm.deal.list'] = 'timeout';
  await moveCard(stay, 'John Smith', ['early'], deps, { groupId: 3, violationIds: [91] });
  assert.deepEqual(fake.logged.map((x) => [x.result, x.safetyCheck]), [['failed', false]]);
});
