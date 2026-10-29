'use strict';

/**
 * Board ↔ Bitrix: one pass, the Bitrix read and the ask step, against fakes.
 * Nothing is decided from an incomplete read; a question is asked only when
 * none is out; the question out, fixed without a reply, is confirmed under it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runCheckPass, runExclusive, boardProblem } = require('../services/boardBitrix/pass');
const { readBitrix, MAX_PAGES, CLOSED_MAX_PAGES } = require('../services/boardBitrix/bitrixRead');
const { askNext, linksFor } = require('../services/boardBitrix/ask');

const NOW = Date.parse('2026-10-29T15:00:00Z');
const freshBoard = { enabled: true, configured: true, lastPollOk: true, lastPollAt: new Date(NOW - 5 * 60 * 1000), pollIntervalSeconds: 300 };
const boardRow = { present: true, cleanName: 'OLABODE OLUDAISI', fleetType: 'owner_operator', truckNorm: '001', status: 'DISPATCHED', teamMembers: [] };
const okDeal = { id: 321, title: 'OLABODE OLUDAISI', stageId: 'C3:UC_XZ955I', semantic: 'P', fleetType: 'owner_operator', truckId: 3 };
const okTruck = { id: 3, title: 'Trucks #001', stageId: 'DT1040_17:UC_90RJVZ' };

function fakes({ store: storeOver = {}, ...over } = {}) {
  const calls = { applied: [], said: [], asked: 0 };
  const deps = {
    store: {
      getSettings: async () => ({ enabled: true }),
      applyPass: async (found, opts) => { calls.applied.push({ found, opts }); return { opened: found, reopened: [], resolved: [] }; },
      questionMessage: async () => ({ chatId: '-100', messageId: '77' }),
      ...storeOver,
    },
    boardConfig: async () => freshBoard,
    boardRows: async () => [boardRow],
    readBitrix: async () => ({ deals: [okDeal], trucks: [okTruck] }),
    askNext: async () => { calls.asked += 1; return { asked: true }; },
    sayUnder: async (args) => { calls.said.push(args); },
    now: () => NOW,
    ...over,
  };
  return { deps, calls };
}

test('switched off, Board feed off, Bitrix not connected: blocked — nothing recorded, nothing asked', async () => {
  for (const [over, text] of [
    [{ store: { getSettings: async () => ({ enabled: false }) } }, /switched off/],
    [{ boardConfig: async () => ({ ...freshBoard, enabled: false }) }, /Dispatcher Board feed is not switched on/],
    [{ readBitrix: async () => { throw Object.assign(new Error('no'), { reason: 'not_configured' }); } }, /Bitrix24 is not connected/],
  ]) {
    const { deps, calls } = fakes(over);
    const out = await runCheckPass({ deps });
    assert.match(out.blocked, text);
    assert.equal(calls.applied.length, 0);
    assert.equal(calls.asked, 0);
  }
});

test('NOTHING IS DECIDED FROM AN INCOMPLETE READ: stale Board, empty Board, no active deals, a Bitrix failure', async () => {
  for (const over of [
    { boardConfig: async () => ({ ...freshBoard, lastPollAt: new Date(NOW - 3 * 3600 * 1000) }) },
    { boardConfig: async () => ({ ...freshBoard, lastPollOk: false }) },
    { boardRows: async () => [] },
    { readBitrix: async () => ({ deals: [{ ...okDeal, semantic: 'F' }], trucks: [] }) },
    { readBitrix: async () => { throw new Error('Bitrix crm.deal.list: QUERY_LIMIT_EXCEEDED'); } },
  ]) {
    const { deps, calls } = fakes(over);
    const out = await runCheckPass({ deps });
    assert.ok(out.error, JSON.stringify(out));
    assert.equal(calls.applied.length, 0, 'the queue is not touched — nothing resolved, nothing filed');
  }
});

test('a good pass records the differences, then asks the next question', async () => {
  const { deps, calls } = fakes({ readBitrix: async () => ({ deals: [{ ...okDeal, fleetType: null }], trucks: [okTruck] }) });
  const out = await runCheckPass({ deps });
  assert.deepEqual(calls.applied[0].found.map((d) => d.key), ['fleet_missing:deal:321']);
  assert.equal(out.discrepancies, 1);
  assert.equal(out.asked, true);
  assert.equal(calls.asked, 1);
});

test('the re-check after "done" passes confirmId and does not ask (the caller confirms first)', async () => {
  const { deps, calls } = fakes();
  await runCheckPass({ deps, confirmId: 9, ask: false });
  assert.equal(calls.applied[0].opts.confirmId, 9);
  assert.equal(calls.asked, 0);
});

test('the question out, fixed with no reply, is confirmed UNDER it — but not the one the owner just said "done" to', async () => {
  const resolved = [
    { id: 5, wasAsked: true, questionNoticeId: 40, askCount: 1 },
    { id: 9, wasAsked: true, questionNoticeId: 41, askCount: 1 },
    { id: 6, wasAsked: false },
  ];
  const { deps, calls } = fakes({ store: { applyPass: async () => ({ opened: [], reopened: [], resolved }) } });
  await runCheckPass({ deps, confirmId: 9 });
  assert.equal(calls.said.length, 1);
  assert.equal(calls.said[0].messageId, '77');
  assert.match(calls.said[0].text, /Fixed/);
});

test('the Board is fresh within twice its own interval (at least thirty minutes)', () => {
  assert.equal(boardProblem(freshBoard, NOW), null);
  assert.ok(boardProblem({ ...freshBoard, lastPollAt: new Date(NOW - 40 * 60 * 1000) }, NOW).error);
  assert.equal(boardProblem({ ...freshBoard, pollIntervalSeconds: 3600, lastPollAt: new Date(NOW - 90 * 60 * 1000) }, NOW), null);
});

test('passes never overlap: the second waits for the first', async () => {
  const order = [];
  let release;
  const first = runExclusive(() => new Promise((r) => { release = r; }).then(() => order.push('first')));
  const second = runExclusive(async () => order.push('second'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
});

// ── the Bitrix read ──────────────────────────────────────────────────────────

function bitrixFake({ deals = [], closed = [], trucks = [], fail = null } = {}) {
  const seen = [];
  const call = async (method, params) => {
    seen.push({ method, params });
    if (fail && fail(method, params)) throw new Error(`Bitrix ${method}: boom`);
    let list = trucks;
    if (method === 'crm.deal.list') list = params.filter.STAGE_SEMANTIC_ID === 'F' ? closed : deals;
    const page = list.slice(params.start, params.start + 50);
    return method === 'crm.item.list' ? { items: page } : page;
  };
  return { deps: { call }, seen };
}
const rawDeal = (id, over = {}) => ({
  ID: String(id), TITLE: `DRIVER ${id} `, STAGE_ID: 'C3:UC_XZ955I', STAGE_SEMANTIC_ID: 'P',
  UF_CRM_ASSIGNED_TRUCK: '3', UF_CRM_PERF_DRIVER_TYPE: '361', ...over,
});

test('reads every page of the active drivers and trucks, the newest closed deals — reads only', async () => {
  const deals = Array.from({ length: 120 }, (_, i) => rawDeal(i + 1));
  const closed = [rawDeal(500, { STAGE_ID: 'C3:LOSE', STAGE_SEMANTIC_ID: 'F' })];
  const { deps, seen } = bitrixFake({ deals, closed, trucks: [{ id: 3, title: 'Trucks #001', stageId: 'DT1040_17:UC_90RJVZ' }] });
  const out = await readBitrix(deps);
  assert.equal(out.deals.length, 121);
  assert.deepEqual(out.deals[0], { id: 1, title: 'DRIVER 1', stageId: 'C3:UC_XZ955I', semantic: 'P', fleetType: 'company', truckId: 3 });
  assert.equal(out.deals.at(-1).semantic, 'F');
  assert.equal(out.trucks.length, 1);
  assert.ok(seen.every((c) => c.method.endsWith('.list')), 'nothing but list reads');
  const dealCalls = seen.filter((c) => c.method === 'crm.deal.list');
  assert.ok(dealCalls.every((c) => c.params.filter.CATEGORY_ID === 3));
  assert.deepEqual([...new Set(dealCalls.map((c) => `${c.params.filter.STAGE_SEMANTIC_ID}:${c.params.order.ID}`))], ['P:ASC', 'F:DESC']);
  assert.equal(seen.find((c) => c.method === 'crm.item.list').params.entityTypeId, 1040);
});

test('years of closed drivers never stop the check: the closed list is read newest first, only so far', async () => {
  const closed = Array.from({ length: (CLOSED_MAX_PAGES + 3) * 50 }, (_, i) => rawDeal(10_000 - i, { STAGE_ID: 'C3:LOSE', STAGE_SEMANTIC_ID: 'F' }));
  const out = await readBitrix(bitrixFake({ deals: [rawDeal(1)], closed }).deps);
  assert.equal(out.deals.length, 1 + CLOSED_MAX_PAGES * 50);
});

test('a failed page, a list too long to finish, or a vanished field fails the whole read', async () => {
  await assert.rejects(readBitrix(bitrixFake({ deals: [rawDeal(1)], fail: (m) => m === 'crm.item.list' }).deps), /boom/);
  const endless = { call: async (m) => (m === 'crm.item.list' ? { items: Array(50).fill({ id: 1 }) } : Array(50).fill(rawDeal(1))) };
  await assert.rejects(readBitrix(endless), new RegExp(`more than ${MAX_PAGES * 50}`));
  const renamed = rawDeal(1);
  delete renamed.UF_CRM_ASSIGNED_TRUCK;
  await assert.rejects(readBitrix(bitrixFake({ deals: [renamed] }).deps), /no longer returns the deal field UF_CRM_ASSIGNED_TRUCK/);
});

// ── asking ───────────────────────────────────────────────────────────────────

function askFakes(over = {}) {
  const sent = [];
  const state = { asked: null, unmarked: 0, notice: null };
  const store = {
    getSettings: async () => ({ enabled: true }),
    currentQuestion: async () => state.asked,
    nextToAsk: async () => ({ id: 7, askCount: 0, details: { kind: 'fleet_missing', board: { name: 'A B', fleetType: 'company' }, deal: { id: 321, title: 'A B', stageId: 'C3:UC_XZ955I' } } }),
    markAsked: async (id) => ({ id, askCount: 1, details: { kind: 'fleet_missing', board: { name: 'A B', fleetType: 'company' }, deal: { id: 321, title: 'A B', stageId: 'C3:UC_XZ955I' } } }),
    countWaiting: async () => 3,
    bumpStaleQuestion: async () => null,
    setQuestionNotice: async (id, noticeId) => { state.notice = noticeId; },
    unmarkAsked: async () => { state.unmarked += 1; },
    ...over,
  };
  const deps = {
    store,
    notify: async (n) => { sent.push(n); return { recorded: true, notice: { id: 99 } }; },
    portalOrigin: async () => 'https://wenze.bitrix24.com',
  };
  return { deps, sent, state };
}

test('asks one question in Needs attention, with the deal link and how many wait, and remembers the notice', async () => {
  const { deps, sent, state } = askFakes();
  const out = await askNext(deps);
  assert.deepEqual(out, { asked: true, id: 7, reminder: false });
  assert.equal(sent[0].category, 'needs_attention');
  assert.equal(sent[0].subjectType, 'board_bitrix_question');
  assert.equal(sent[0].discriminator, 'ask:1');
  assert.equal(sent[0].question, undefined, 'no question_json: the control channel never sees it');
  assert.ok(sent[0].lines.some((l) => l.includes('https://wenze.bitrix24.com/crm/deal/details/321/')));
  assert.ok(sent[0].lines.some((l) => /3 more difference/.test(l)));
  assert.equal(state.notice, 99);
});

test('never a second question while one is out; a race on the unique index reads as "waiting"; no group puts it back', async () => {
  assert.equal((await askNext(askFakes({ currentQuestion: async () => ({ id: 1 }) }).deps)).reason, 'waiting_for_answer');
  const race = askFakes({ markAsked: async () => { throw Object.assign(new Error('dup'), { code: '23505' }); } });
  assert.equal((await askNext(race.deps)).reason, 'waiting_for_answer');
  const nowhere = askFakes();
  nowhere.deps.notify = async () => ({ recorded: false, reason: 'no_destination' });
  assert.equal((await askNext(nowhere.deps)).reason, 'no_destination');
  assert.equal(nowhere.state.unmarked, 1);
  assert.equal((await askNext(askFakes({ getSettings: async () => ({ enabled: false }) }).deps)).reason, 'off');
});

test('a question nobody answered for a day is posted again as a reminder — still the only one out', async () => {
  const stale = { id: 1, askCount: 2, details: { kind: 'not_on_board', deal: { id: 321, title: 'A B', stageId: 'C3:NEW' } } };
  const { deps, sent, state } = askFakes({ currentQuestion: async () => ({ id: 1 }), bumpStaleQuestion: async (hours) => (hours === 24 ? stale : null) });
  const out = await askNext(deps);
  assert.deepEqual(out, { asked: true, id: 1, reminder: true });
  assert.match(sent[0].title, /^Reminder — Board ↔ Bitrix: /);
  assert.equal(sent[0].discriminator, 'ask:2');
  deps.notify = async () => ({ recorded: false, reason: 'no_destination' });
  assert.equal((await askNext(deps)).reason, 'no_destination');
  assert.equal(state.unmarked, 0, 'a reminder that reached nobody leaves the question out');
});

test('economy mode: nothing is asked or reminded while the check is paused', async () => {
  const { deps, sent } = askFakes();
  deps.paused = () => 'paused to save database traffic until …';
  assert.equal((await askNext(deps)).reason, 'paused');
  assert.equal(sent.length, 0);
});

test('links carry the portal origin only, and nothing when it is unknown', () => {
  const links = linksFor('https://wenze.bitrix24.com');
  assert.equal(links.truckUrl(115), 'https://wenze.bitrix24.com/crm/type/1040/details/115/');
  assert.deepEqual(linksFor(null), {});
});
