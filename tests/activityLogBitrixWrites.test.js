'use strict';

/**
 * Monitoring → Logs, end to end through the REAL default dependencies: a
 * Board ↔ Bitrix button press, the automatic status sync (a write and a
 * guard's refusal), a hiring Move press, a home-time card move. Only the
 * database modules, the Telegram side and `fetch` are fakes — the Bitrix
 * client, its recorder and every call site are the production code, so an
 * entry that is missing here is missing in production. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = {
    id: filename, filename, loaded: true, exports,
  };
}

// ── fakes ───────────────────────────────────────────────────────────────────

const logged = [];
const notices = [];
const said = [];
let boardStatusStillTrue = true;

stub('database/bitrix.js', { getBitrixConfig: async () => ({ enabled: true, webhookUrl: 'https://acme.bitrix24.com/rest/1/s3cret/' }) });
stub('database/activityLog.js', {
  PAGE_SIZE: 50,
  insertEntry: async (e) => { logged.push({ id: logged.length + 1, ...e }); return { id: logged.length }; },
  recentForTrigger: async (trigger, limit) => logged.filter((e) => e.trigger === trigger).reverse().slice(0, limit),
});
stub('services/notifications/send.js', { notify: async (n) => { notices.push(n); return { recorded: true }; } });
stub('database/operationalNotifications.js', {
  findNoticeByTelegramMessage: async () => ({ subjectId: '5', subjectType: 'board_bitrix_question' }),
  noticeSentWithin: async () => false,
});
stub('database/controlOperators.js', { isControlOperator: async () => false });
stub('database/backgroundRuns.js', { recordRunStart: async () => {}, recordRunFinish: async () => {} });
stub('database/boardBitrixAdvice.js', {
  getResponderIds: async () => ['777'],
  getAdvice: async () => ({
    actions: [{
      type: 'set_stage', label: 'Move to HOME',
      params: { dealId: 321, stageId: 'C9:H', stageName: 'HOME', fromStageId: 'C9:W' },
    }],
  }),
});
stub('database/boardBitrix.js', {
  getSettings: async () => ({
    enabled: false, schemaSource: 'catalog_exact',
    schemaMapping: { dealFields: { truck: 'UF_T', driverType: 'UF_D' }, truckEntityTypeId: 1040 },
  }),
  getDiscrepancy: async () => ({ id: 5, state: 'asked', askCount: 1, kind: 'status_differs' }),
  claimStageSync: async () => 7,
  stageSyncAttempt: async () => 2,
  finishStageSync: async () => {},
  confirmBoardStatus: async () => boardStatusStillTrue,
  isLiveSyncEnabled: async () => true,
});
stub('services/boardBitrix/ask.js', {
  SUBJECT_TYPE: 'board_bitrix_question',
  askNext: async () => ({}),
  sayUnder: async (args) => { said.push(args); },
  linksFor: () => ({}),
});
const proposal = {
  id: 11, chatId: '-100', rootMessageId: 900, kind: 'move', dealId: 321, dealTitle: 'Ann Lee',
  fromStageId: 'C5:NEW', fromStageName: 'New', toStageId: 'C5:SAFETY', toStageName: 'Sent to Safety',
};
stub('database/hiringStages/proposals.js', {
  getProposal: async () => ({ ...proposal, status: 'pending' }),
  transition: async (id, from, to) => ({ ...proposal, status: to }),
});
stub('database/hiringStages/crmRecords.js', {
  claim: async ({ chatId, rootMessageId }) => ({
    record: {
      id: 31, chatId, rootMessageId, status: 'claimed', displayName: 'Ann Lee',
    },
  }),
  advance: async () => ({ id: 31 }),
  getForRoot: async () => null,
});
stub('services/hiringStages/groupMessages.js', {
  sendProposal: async () => {}, sendNotice: async () => {}, refreshProposal: async () => {}, closeProposal: async () => {},
});

/** A fake Bitrix behind the real client's default `fetch`. */
let deals = {};
global.fetch = async (url, init) => {
  const method = String(url).replace(/^.*\/rest\/1\/s3cret\//, '').replace(/\.json$/, '');
  const params = JSON.parse(init?.body || '{}');
  let result;
  if (method === 'crm.deal.get') result = deals[params.id];
  else if (method === 'crm.deal.update') {
    deals[params.id] = { ...deals[params.id], ...params.fields };
    result = true;
  } else if (method === 'crm.deal.list') result = Object.values(deals).filter((d) => String(d.CATEGORY_ID) === '33');
  else if (method === 'crm.duplicate.findbycomm') result = { CONTACT: [] };
  else if (method === 'crm.contact.list') result = [];
  else if (method === 'crm.contact.add') result = 55;
  else if (method === 'crm.deal.add') {
    deals[99] = {
      ID: '99', TITLE: params.fields.TITLE, STAGE_ID: params.fields.STAGE_ID, CATEGORY_ID: '5', CLOSED: 'N',
    };
    result = 99;
  } else if (method === 'crm.lead.add') result = 77;
  else return new Response(JSON.stringify({ error: 'ERROR_METHOD_NOT_FOUND' }), { status: 400 });
  return new Response(JSON.stringify({ result }), { status: 200 });
};

function reset() {
  logged.length = 0;
  notices.length = 0;
  said.length = 0;
  boardStatusStillTrue = true;
  deals = {
    321: {
      ID: '321', TITLE: 'ALAN BROWN', STAGE_ID: 'C9:W', CATEGORY_ID: '9', CLOSED: 'N',
    },
  };
}

// ── the paths ───────────────────────────────────────────────────────────────

test('a Board ↔ Bitrix button press records who pressed, the stage from → to, and why', async () => {
  reset();
  const { handleBoardBitrixButton } = require('../services/boardBitrix/buttons');
  const out = await handleBoardBitrixButton({
    data: 'bbx:5:0', chatId: -1001, messageId: 42, telegramUserId: 777, fromName: 'Dina Dispatcher', fromIsBot: false,
  });
  assert.notEqual(out.alert, true, out.text);
  assert.equal(deals[321].STAGE_ID, 'C9:H', 'the write went through');
  assert.equal(logged.length, 1);
  const e = logged[0];
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

const NOW = Date.parse('2026-11-14T12:00:00Z');
const discrepancy = () => ({
  kind: 'status_differs', key: 'status_differs:deal:321',
  board: {
    rowKey: 'owner_operator:001:alan-brown', status: 'HOME', statusChangedAt: new Date(NOW - 60 * 60000),
    name: 'ALAN BROWN', fleetType: 'owner_operator', truck: '001',
  },
  deal: {
    id: 321, title: 'ALAN BROWN', stageId: 'C9:W', fleetType: 'owner_operator', truckNumber: '001',
  },
  expectedStageId: 'C9:H',
});
const schema = {
  categoryId: 9, stageByRole: { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' }, fingerprint: 'abc', writeSafe: true,
};

function syncWithRealDeps() {
  const stageSync = require('../services/boardBitrix/stageSync');
  const deps = { ...stageSync.defaultDeps(), now: () => NOW };
  return stageSync.runStageSync({
    discrepancies: [discrepancy()], schema, mode: 'live', deps,
  });
}

test('the status sync records its write as automatic, with the attempt and the Board\'s status', async () => {
  reset();
  const out = await syncWithRealDeps();
  assert.equal(out.applied, 1);
  assert.equal(logged.length, 1);
  const e = logged[0];
  assert.equal(e.actorKind, 'automatic');
  assert.equal(e.trigger, 'board_bitrix.sync');
  assert.equal(e.result, 'done');
  assert.equal(e.attempt, 2);
  assert.match(e.correlationKey, /^stage:/);
  assert.equal(e.evidence.boardStatus, 'HOME');
  assert.equal(e.evidence.rowKey, undefined, 'the Board row key names the person — never evidence');
  assert.deepEqual(e.change, [{ field: 'STAGE_ID', from: 'C9:W', to: 'C9:H' }]);
});

test('a guard\'s refusal is its own entry; three in a row tell the owner once', async () => {
  reset();
  boardStatusStillTrue = false;
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const out = await syncWithRealDeps();
    assert.equal(out.failed, 1);
  }
  assert.equal(deals[321].STAGE_ID, 'C9:W', 'nothing was written');
  assert.equal(logged.length, 4);
  assert.ok(logged.every((e) => e.result === 'refused' && e.action === 'deal.stage' && e.trigger === 'board_bitrix.sync'));
  assert.match(logged[0].error, /Dispatcher Board status changed/);
  // The notice: three in a row → one; the fourth is the same streak (the
  // outbox's unique key would refuse it; the decision already does).
  assert.equal(notices.length, 2, 'the third and fourth decide to tell — same key, the outbox says it once');
  assert.equal(notices[0].discriminator, notices[1].discriminator);
  assert.equal(notices[0].category, 'system_errors');
  assert.match(notices[0].title, /3 changes in a row/);
});

test('a hiring Move press records the presser and the stage from → to', async () => {
  reset();
  deals[321] = {
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
  assert.equal(logged.length, 1);
  const e = logged[0];
  assert.equal(e.trigger, 'hiring_stage.move');
  assert.equal(e.actorKind, 'person_button');
  assert.equal(e.actorTelegramId, 42);
  assert.equal(e.actorName, 'Rita Recruiter');
  assert.equal(e.evidence.proposalId, 11);
  assert.deepEqual(e.change, [{ field: 'STAGE_ID', from: 'New (C5:NEW)', to: 'Sent to Safety (C5:SAFETY)' }]);
});

test('a home-time card move is automatic, with the violation as the reason', async () => {
  reset();
  deals = {
    88: {
      ID: '88', TITLE: 'JOHN SMITH', STAGE_ID: 'C33:NEW', CATEGORY_ID: '33', CLOSED: 'N',
    },
  };
  const { moveCard } = require('../services/homeTime/ownViolations');
  const { callBitrix } = require('../services/bitrix24DealStages');
  const card = await moveCard({ homeFrom: '2026-11-01', homeDays: 6, roadDays: 20 }, 'John Smith', ['early', 'overstay'],
    { bitrix: callBitrix }, { groupId: 3, violationIds: [91, 92] });
  assert.match(card.note, /moved to/);
  assert.equal(logged.length, 1);
  const e = logged[0];
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
  assert.equal(deals[321].STAGE_ID, 'C9:S');
});

test('a read is never recorded', async () => {
  reset();
  const { callBitrix } = require('../services/bitrix24DealStages');
  await callBitrix('crm.deal.get', { id: 321 });
  assert.equal(logged.length, 0);
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
  assert.deepEqual(logged.map((e) => [e.action, e.targetId, e.result]), [['contact.create', '55', 'done'], ['deal.create', '99', 'done']]);
  for (const e of logged) {
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
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, 'lead.create');
  assert.equal(logged[0].targetId, '77');
  assert.deepEqual(logged[0].change, [{ field: 'source', from: null, to: 'Facebook lead form' }]);
});
