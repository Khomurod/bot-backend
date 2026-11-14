'use strict';

/**
 * Monitoring → Logs, end to end through the REAL default dependencies: a
 * Board ↔ Bitrix button press, the automatic status sync (a write and a
 * safety check's refusal), a hiring Move press, a home-time card move. Only
 * the database modules, the Telegram side and `fetch` are fakes
 * (tests/helpers/activityLogFakes.js) — the Bitrix client, its recorder and
 * every call site are the production code, so an entry that is missing here
 * is missing in production. Names are made up. Attempts that end before
 * their write: tests/activityLogAttempts.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fake, reset, settled, syncWithRealDeps,
} = require('./helpers/activityLogFakes');

// ── the paths ───────────────────────────────────────────────────────────────

test('a Board ↔ Bitrix button press records who pressed, the stage from → to, and why', async () => {
  reset();
  const { handleBoardBitrixButton } = require('../services/boardBitrix/buttons');
  const out = await handleBoardBitrixButton({
    data: 'bbx:5:0', chatId: -1001, messageId: 42, telegramUserId: 777, fromName: 'Dina Dispatcher', fromIsBot: false,
  });
  assert.notEqual(out.alert, true, out.text);
  assert.equal(fake.deals[321].STAGE_ID, 'C9:H', 'the write went through');
  assert.equal(fake.logged.length, 1);
  const e = fake.logged[0];
  assert.equal(e.action, 'deal.stage');
  assert.equal(e.targetId, '321');
  assert.equal(e.targetLabel, 'ALAN BROWN');
  assert.equal(e.actorKind, 'person_button');
  assert.equal(e.actorTelegramId, 777);
  assert.equal(e.actorName, 'Dina Dispatcher');
  assert.equal(e.trigger, 'board_bitrix.button');
  assert.equal(e.result, 'done');
  assert.deepEqual(e.change, [{ field: 'STAGE_ID', from: 'C9:W', to: 'HOME (C9:H)' }]);
  assert.equal(e.evidence.questionId, 5);
  assert.match(e.reason, /Pressed a button/);
});

test('the status sync records its write as automatic, with the attempt and the Board\'s status', async () => {
  reset();
  const out = await syncWithRealDeps();
  assert.equal(out.applied, 1);
  assert.equal(fake.logged.length, 1);
  const e = fake.logged[0];
  assert.equal(e.actorKind, 'automatic');
  assert.equal(e.trigger, 'board_bitrix.sync');
  assert.equal(e.result, 'done');
  assert.equal(e.attempt, 2);
  assert.match(e.correlationKey, /^stage:/);
  assert.equal(e.evidence.boardStatus, 'HOME');
  assert.equal(e.evidence.rowKey, undefined, 'the Board row key names the person — never evidence');
  assert.deepEqual(e.change, [{ field: 'STAGE_ID', from: 'C9:W', to: 'C9:H' }]);
});

test('a safety check\'s refusal is its own entry, and never tells the owner — Bitrix never said no', async () => {
  reset();
  fake.boardStatusStillTrue = false;
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const out = await syncWithRealDeps();
    assert.equal(out.failed, 1);
  }
  await settled();
  assert.equal(fake.deals[321].STAGE_ID, 'C9:W', 'nothing was written');
  assert.equal(fake.logged.length, 4);
  assert.ok(fake.logged.every((e) => e.result === 'refused' && e.safetyCheck === true
    && e.action === 'deal.stage' && e.trigger === 'board_bitrix.sync'));
  assert.match(fake.logged[0].error, /Dispatcher Board status changed/);
  assert.equal(fake.notices.length, 0, 'four safety-check refusals are not Bitrix refusing');
});

test('Bitrix refusing the write three times in a row tells the owner once, with the feature named', async () => {
  reset();
  fake.fail['crm.deal.update'] = 'refuse';
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await syncWithRealDeps();
    // eslint-disable-next-line no-await-in-loop
    await settled();
  }
  assert.equal(fake.logged.length, 4);
  assert.ok(fake.logged.every((e) => e.result === 'refused' && e.safetyCheck === false));
  assert.equal(fake.notices.length, 1, 'once for the streak — the fourth is the same streak');
  const n = fake.notices[0];
  assert.equal(n.category, 'system_errors');
  assert.equal(n.discriminator, `streak:${fake.logged[0].id}`);
  assert.match(n.title, /3 changes in a row/);
  assert.match(n.lines.join(' '), /automatic status sync/);
  assert.match(n.lines.join(' '), /Bitrix said no — Bitrix crm\.deal\.update: Access denied/);
  assert.doesNotMatch(JSON.stringify(n), /s3cret|ALAN|BROWN/);
});

test('the streak check never holds up the write: the caller has its answer first', async () => {
  reset();
  fake.fail['crm.deal.update'] = 'refuse';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const record = require('../services/activityLog/record');
  const { callBitrix } = require('../services/bitrix24DealStages');
  let checked = false;
  const err = await callBitrix('crm.deal.update', { id: 321, fields: { STAGE_ID: 'C9:S' } }, {
    audit: { actorKind: 'automatic', trigger: 'board_bitrix.sync' },
    recordWrite: (w) => record.recordBitrixWrite(w, {
      store: { insertEntry: async () => ({ id: 1 }) },
      afterFailure: async () => { await gate; checked = true; },
    }),
  }).catch((e) => e);
  assert.match(err.message, /Access denied/, 'the refusal reached the caller while the check still waits');
  assert.equal(err.activityRecorded, true, 'marked: its caller must not record it again');
  assert.equal(checked, false);
  release();
  await record.__settledForTests();
  assert.equal(checked, true);
});

test('a hiring Move press records the presser and the stage from → to', async () => {
  reset();
  fake.deals[321] = {
    ID: '321', TITLE: 'Ann Lee', STAGE_ID: 'C5:NEW', CATEGORY_ID: '5', CLOSED: 'N',
  };
  const { handleStageButton } = require('../services/hiringStages/actions');
  const out = await handleStageButton({
    action: 'ok', proposalId: 11, chatId: '-100', from: { id: 42, first_name: 'Rita', last_name: 'Recruiter' },
  }, {
    getSettings: async () => ({ enabled: true, stageProposalsEnabled: true, chatId: '-100' }),
    telegram: {},
  });
  assert.match(out.text, /Done/);
  assert.equal(fake.logged.length, 1);
  const e = fake.logged[0];
  assert.equal(e.trigger, 'hiring_stage.move');
  assert.equal(e.actorKind, 'person_button');
  assert.equal(e.actorTelegramId, 42);
  assert.equal(e.actorName, 'Rita Recruiter');
  assert.equal(e.evidence.proposalId, 11);
  assert.deepEqual(e.change, [{ field: 'STAGE_ID', from: 'New (C5:NEW)', to: 'Sent to Safety (C5:SAFETY)' }]);
});

test('a home-time card move is automatic, with the violation as the reason', async () => {
  reset();
  fake.deals = {
    88: {
      ID: '88', TITLE: 'JOHN SMITH', STAGE_ID: 'C33:NEW', CATEGORY_ID: '33', CLOSED: 'N',
    },
  };
  const { moveCard } = require('../services/homeTime/ownViolations');
  const { callBitrix } = require('../services/bitrix24DealStages');
  const card = await moveCard({ homeFrom: '2026-11-01', homeDays: 6, roadDays: 20 }, 'John Smith', ['early', 'overstay'],
    { bitrix: callBitrix }, { groupId: 3, violationIds: [91, 92] });
  assert.match(card.note, /moved to/);
  assert.equal(fake.logged.length, 1);
  const e = fake.logged[0];
  assert.equal(e.trigger, 'home_time.violation_card');
  assert.equal(e.actorKind, 'automatic');
  assert.equal(e.action, 'deal.stage');
  assert.equal(e.evidence.violationIds, '91,92');
  assert.match(e.reason, /early \+ overstay/);
  assert.equal(e.change[0].to, 'C33:UC_HTEARLYOVER');
});

test('a failed log insert never fails the write', async () => {
  reset();
  const { callBitrix } = require('../services/bitrix24DealStages');
  const ok = await callBitrix('crm.deal.update', { id: 321, fields: { STAGE_ID: 'C9:S' } }, {
    audit: { actorKind: 'automatic', trigger: 'test' },
    recordWrite: (w) => require('../services/activityLog/record').recordBitrixWrite(w, {
      store: { insertEntry: async () => { throw new Error('database down'); } },
    }),
  });
  assert.equal(ok, true);
  assert.equal(fake.deals[321].STAGE_ID, 'C9:S');
});

test('a read is never recorded', async () => {
  reset();
  const { callBitrix } = require('../services/bitrix24DealStages');
  await callBitrix('crm.deal.get', { id: 321 });
  assert.equal(fake.logged.length, 0);
});

test('a hiring creation records both new records as automatic, with the post as evidence and no phone', async () => {
  reset();
  const { ensureCandidateDeal } = require('../services/hiringStages/crmCreate');
  const made = await ensureCandidateDeal({
    chatId: '-100', rootMessageId: 900, categoryId: '5', stages: [{ id: 'C5:SAFETY', name: 'Sent to Safety' }],
    identity: {
      ok: true, name: 'Ann Lee', displayName: 'Ann Lee', first: 'Ann', last: 'Lee', phone: '3125550199',
    },
  });
  assert.equal(made.status, 'created');
  assert.deepEqual(fake.logged.map((e) => [e.action, e.targetId, e.result]), [['contact.create', '55', 'done'], ['deal.create', '99', 'done']]);
  for (const e of fake.logged) {
    assert.equal(e.trigger, 'hiring_stage.create');
    assert.equal(e.actorKind, 'automatic');
    assert.equal(e.evidence.rootMessageId, 900);
    assert.equal(e.targetLabel, 'Ann Lee');
    assert.doesNotMatch(JSON.stringify(e), /5550199/);
  }
});

test('a Facebook lead\'s creation is recorded without the candidate\'s details', async () => {
  reset();
  const { createCrmRecordFromLead } = require('../services/bitrix24Service');
  const out = await createCrmRecordFromLead({
    fieldMap: {}, leadData: { field_data: [] }, connection: { page_name: 'P' }, leadgenId: 'L1',
    audit: {
      actorKind: 'automatic', trigger: 'facebook_lead.create', reason: 'r', targetLabel: 'Bo Diaz',
      change: [{ field: 'source', from: null, to: 'Facebook lead form' }],
    },
  });
  assert.equal(out.ok, true);
  assert.equal(fake.logged.length, 1);
  assert.equal(fake.logged[0].action, 'lead.create');
  assert.equal(fake.logged[0].targetId, '77');
  assert.deepEqual(fake.logged[0].change, [{ field: 'source', from: null, to: 'Facebook lead form' }]);
});
