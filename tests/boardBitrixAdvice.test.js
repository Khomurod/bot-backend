'use strict';

/**
 * Board ↔ Bitrix questions that say what to do (owner, 11 November 2026):
 * the rule-built fixes, a model that may only CHOOSE among them, the advice
 * and buttons under the question, a tap that does exactly the shown fix after
 * Bitrix is read again, and Skip that asks the next question. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  candidateActions, adviceLines, adviceKeyboard, CALLBACK_PATTERN,
} = require('../lib/boardBitrix/actions');
const { adviseOn, relatedBoardLines } = require('../services/boardBitrix/advice');
const { askNext } = require('../services/boardBitrix/ask');
const { handleBoardBitrixButton } = require('../services/boardBitrix/buttons');
const { applyAction } = require('../services/boardBitrix/apply');
const { STATIC_SCHEMA } = require('../lib/boardBitrix/vocabulary');
const { AiUnavailableError } = require('../services/ai/router');

const SCHEMA = { ...STATIC_SCHEMA, activeTruckStageIds: ['DT1040_17:ROAD'] };
const NOT_ON_BOARD = { kind: 'not_on_board', deal: { id: 4690, title: 'STOVER SHEILA', stageId: 'C3:UC_XZ955I', truckNumber: '012' } };
const CLOSE = [{ id: 'C3:LOSE', name: 'TERMINATED' }, { id: 'C3:LEFT', name: 'LEFT' }, { id: 'C3:APOLOGY', name: 'RESIGNED' }];

test('the fixes are built by rules from the Board, each with where Bitrix stood', () => {
  const close = candidateActions(NOT_ON_BOARD, { schema: SCHEMA, closeStages: CLOSE });
  assert.deepEqual(close.map((a) => a.label), ['Move "STOVER SHEILA" to TERMINATED', 'Move "STOVER SHEILA" to LEFT', 'Move "STOVER SHEILA" to RESIGNED']);
  assert.equal(close[0].params.fromStageId, 'C3:UC_XZ955I');

  const truck = candidateActions({ kind: 'truck_differs', board: { name: 'A B', truck: '310', fleetType: 'company' }, deal: { id: 1, title: 'A B', truckId: 9 } }, { schema: SCHEMA });
  assert.deepEqual(truck[0], {
    type: 'set_truck',
    label: 'Assign truck 310 to "A B"',
    params: {
      dealId: 1, truckNumber: '310', fleet: 'company', fromTruckId: 9,
    },
  });
  assert.deepEqual(candidateActions({ kind: 'missing_in_bitrix', board: { name: 'A B' } }, { schema: SCHEMA }), [], 'a deal to create: by hand');
  const rename = candidateActions({ kind: 'name_differs', board: [{ name: 'TORREY SWATT', truck: '012' }], deals: [{ id: 5, title: 'TORREY SWAT' }] }, { schema: SCHEMA });
  assert.equal(rename[0].params.title, 'TORREY SWATT');
});

test('the advice: wrapped so no line is clipped, one button per fix, then Skip', () => {
  const advice = { recommendation: 'word '.repeat(80).trim(), actions: candidateActions(NOT_ON_BOARD, { schema: SCHEMA, closeStages: CLOSE }) };
  const lines = adviceLines(advice);
  assert.ok(lines.every((l) => l.length <= 160));
  assert.match(lines[0], /^💡 word/);
  const kb = adviceKeyboard(405, advice).inline_keyboard;
  assert.deepEqual(kb.map((r) => r[0].callback_data), ['bbx:405:0', 'bbx:405:1', 'bbx:405:2', 'bbx:405:s']);
  assert.ok(kb.every((r) => CALLBACK_PATTERN.test(r[0].callback_data)));
});

const BOARD_ROWS = [
  { driverNameRaw: 'TORREY SWATT', cleanName: 'TORREY SWATT', truckNorm: '012', truckRaw: '012 COMP', fleetType: 'company', status: 'HOME', teamMembers: [] },
  { driverNameRaw: 'JOHN DOE', cleanName: 'JOHN DOE', truckNorm: '400', truckRaw: '400', status: 'ENROUTE', teamMembers: [] },
];

function adviceDeps(aiAnswer) {
  const seen = [];
  return {
    seen,
    deps: {
      settings: async () => ({ schemaMapping: SCHEMA }),
      call: async () => CLOSE.map((s, i) => ({ STATUS_ID: s.id, NAME: s.name, SORT: 100 + i, EXTRA: { SEMANTICS: 'F' } })),
      boardRows: async () => BOARD_ROWS,
      run: async (args) => {
        seen.push(args);
        if (aiAnswer instanceof Error) throw aiAnswer;
        return { parsed: aiAnswer, model: 'fake' };
      },
    },
  };
}

test('THE MODEL SEES EVERYTHING ABOUT THE QUESTION, and may only choose among the fixes', async () => {
  const { deps, seen } = adviceDeps({ recommendation: 'Truck 012 on the Board shows only Torrey Swatt; if Sheila still drives with him, add her as the team driver on the Board.', offer: [2, 7, 2] });
  const advice = await adviseOn(NOT_ON_BOARD, deps);
  assert.match(seen[0].userText, /STOVER SHEILA/);
  assert.match(seen[0].userText, /TORREY SWATT/, 'the Board line on the same truck');
  assert.doesNotMatch(seen[0].userText, /JOHN DOE/, 'unrelated lines stay out');
  assert.match(advice.recommendation, /team driver on the Board/);
  assert.deepEqual(advice.actions.map((a) => a.params.stageName), ['RESIGNED'], 'an index not offered is dropped; no repeats');
  assert.equal(relatedBoardLines(NOT_ON_BOARD, BOARD_ROWS).length, 1);
});

test('no model: every rule-built fix is offered, with no recommendation of its own', async () => {
  const { deps } = adviceDeps(new AiUnavailableError('none'));
  const advice = await adviseOn(NOT_ON_BOARD, deps);
  assert.equal(advice.recommendation, null);
  assert.equal(advice.actions.length, 3);
});

test('the question carries the advice and its buttons; a reminder keeps the advice it showed', async () => {
  const sent = [];
  let saved = null;
  const question = { id: 405, askCount: 1, details: NOT_ON_BOARD };
  const deps = {
    paused: () => null,
    store: {
      getSettings: async () => ({ enabled: true }),
      currentQuestion: async () => null,
      nextToAsk: async () => question,
      markAsked: async () => question,
      countWaiting: async () => 41,
      setQuestionNotice: async () => {},
    },
    portalOrigin: async () => null,
    notify: async (n) => { sent.push(n); return { recorded: true, notice: { id: 1 } }; },
    advice: { saveAdvice: async (id, a) => { saved = a; }, getAdvice: async () => saved },
    adviseOn: async () => ({ recommendation: 'Close the deal if she left.', actions: candidateActions(NOT_ON_BOARD, { schema: SCHEMA, closeStages: CLOSE }) }),
  };
  assert.deepEqual(await askNext(deps), { asked: true, id: 405, reminder: false });
  assert.ok(sent[0].lines.includes('💡 Close the deal if she left.'));
  assert.equal(sent[0].replyMarkup.inline_keyboard.length, 4);
  assert.equal(saved.actions.length, 3);
});

function buttonDeps({ responder = true, state = 'asked', applied = { ok: true, done: 'moved to RESIGNED' }, after = 'resolved' } = {}) {
  const calls = { applied: [], said: [], asked: 0, snoozed: 0 };
  let reads = 0;
  const advice = { actions: candidateActions(NOT_ON_BOARD, { schema: SCHEMA, closeStages: CLOSE }) };
  return {
    calls,
    deps: {
      operators: { isControlOperator: async () => false },
      advice: { getResponderIds: async () => (responder ? ['555'] : []), getAdvice: async () => advice },
      notices: { findNoticeByTelegramMessage: async (chatId, mid) => (mid === 77 ? { subjectType: 'board_bitrix_question', subjectId: '405' } : null) },
      store: {
        getDiscrepancy: async () => { reads += 1; return { id: 405, askCount: 1, state: reads === 1 ? state : after, details: NOT_ON_BOARD }; },
        snooze: async () => { calls.snoozed += 1; return { id: 405 }; },
      },
      apply: async (a) => { calls.applied.push(a); return applied; },
      recheck: async () => ({ discrepancies: 0 }),
      askNext: async () => { calls.asked += 1; },
      say: async (a) => { calls.said.push(a); },
      portalOrigin: async () => null,
    },
  };
}
const press = (data, over = {}) => ({
  data, chatId: -100, messageId: 77, telegramUserId: 555, fromIsBot: false, ...over,
});

test('A TAP does exactly the fix it showed, then re-checks and asks the next question', async () => {
  const { deps, calls } = buttonDeps();
  const out = await handleBoardBitrixButton(press('bbx:405:2'), deps);
  assert.equal(out.text, 'Done.');
  assert.equal(calls.applied[0].params.stageName, 'RESIGNED');
  assert.match(calls.said[0].text, /^✅ Done — move "STOVER SHEILA" to RESIGNED: moved to RESIGNED/);
  assert.equal(calls.asked, 1);
});

test('SKIP tapped is "skip" typed: back in line, the next question at once', async () => {
  const { deps, calls } = buttonDeps();
  assert.equal((await handleBoardBitrixButton(press('bbx:405:s'), deps)).text, 'Skipped — next question.');
  assert.equal(calls.snoozed, 1);
  assert.equal(calls.asked, 1);
  assert.equal(calls.applied.length, 0);
});

test('a tap by somebody not on the list, on another message, or on a closed question does nothing', async () => {
  const outsider = buttonDeps({ responder: false });
  assert.equal((await handleBoardBitrixButton(press('bbx:405:0'), outsider.deps)).alert, true);
  assert.equal(outsider.calls.applied.length, 0);
  const elsewhere = buttonDeps();
  assert.match((await handleBoardBitrixButton(press('bbx:405:0', { messageId: 78 }), elsewhere.deps)).text, /changed/);
  const closed = buttonDeps({ state: 'resolved' });
  assert.match((await handleBoardBitrixButton(press('bbx:405:0'), closed.deps)).text, /not open/);
  assert.equal(elsewhere.calls.applied.length + closed.calls.applied.length, 0);
});

test('Bitrix moved meanwhile: the fix is refused and said; nothing else happens', async () => {
  const { deps, calls } = buttonDeps({ applied: { ok: false, why: 'the deal\'s stage was changed meanwhile' } });
  await handleBoardBitrixButton(press('bbx:405:0'), deps);
  assert.match(calls.said[0].text, /Not done: the deal's stage was changed meanwhile/);
  assert.equal(calls.asked, 0);
});

function bitrix(deal, { proven = true } = {}) {
  const writes = [];
  return {
    writes,
    deps: {
      settings: async () => ({ schemaMapping: SCHEMA, schemaSource: proven ? 'catalog_exact' : 'static_fallback' }),
      call: async (method, params) => {
        if (method === 'crm.deal.get') return deal;
        if (method === 'crm.item.list') return { items: [{ id: 31, title: 'Trucks #310', stageId: 'DT1040_17:ROAD' }, { id: 32, title: 'Trucks #311', stageId: 'DT1040_17:ROAD' }] };
        writes.push({ method, params });
        return true;
      },
    },
  };
}

test('APPLY re-reads Bitrix: one field written; a moved deal or an unproven layout writes nothing', async () => {
  const [terminate] = candidateActions(NOT_ON_BOARD, { schema: SCHEMA, closeStages: CLOSE });
  const ok = bitrix({ ID: '4690', STAGE_ID: 'C3:UC_XZ955I' });
  assert.deepEqual(await applyAction(terminate, ok.deps), { ok: true, done: 'moved to TERMINATED' });
  assert.deepEqual(ok.writes, [{ method: 'crm.deal.update', params: { id: 4690, fields: { STAGE_ID: 'C3:LOSE' }, params: { REGISTER_SONET_EVENT: 'Y' } } }]);

  const moved = bitrix({ ID: '4690', STAGE_ID: 'C3:UC_UF0NDK' });
  assert.equal((await applyAction(terminate, moved.deps)).ok, false);
  assert.equal(moved.writes.length, 0);

  const unproven = bitrix({ ID: '4690', STAGE_ID: 'C3:UC_XZ955I' }, { proven: false });
  assert.match((await applyAction(terminate, unproven.deps)).why, /not proven/);
  assert.equal(unproven.writes.length, 0);

  const [truck] = candidateActions({ kind: 'truck_missing', board: { name: 'A B', truck: '310' }, deal: { id: 1, title: 'A B', truckId: null } }, { schema: SCHEMA });
  const t = bitrix({ ID: '1', [SCHEMA.dealFields.truck]: null });
  assert.equal((await applyAction(truck, t.deps)).ok, true);
  assert.deepEqual(t.writes[0].params.fields, { [SCHEMA.dealFields.truck]: 31 });
});

test('THE TRUCKS PROCESS IS NOT TOUCHED (owner, 13 November 2026): no truck button, and an old one writes nothing', async () => {
  const pair = { board: { name: 'ERIC SPARKS', truck: '329', status: 'DISPATCHED', fleetType: 'company' }, deal: { id: 5969, title: 'ERIC SPARKS', truckId: 427 } };
  assert.deepEqual(candidateActions({ kind: 'truck_inactive', ...pair, truck: { id: 427, stageId: 'DT1040_17:SHOP' } }, { schema: SCHEMA }), []);
  const stored = { type: 'truck_on_road', label: 'Move truck 329 to "On the road"', params: { truckId: 427, fromStageId: 'DT1040_17:SHOP' } };
  const b = bitrix({ ID: '5969', STAGE_ID: 'C3:UC_XZ955I' });
  assert.deepEqual(await applyAction(stored, b.deps), { ok: false, why: 'this is not something the bot can do' });
  assert.equal(b.writes.length, 0, 'a button saved under an older question moves no truck');
  assert.equal(candidateActions({ kind: 'truck_missing', ...pair, deal: { ...pair.deal, truckId: null } }, { schema: SCHEMA })[0].type, 'set_truck',
    'the "Assign truck" button stays: it writes the deal, not the truck');
});
