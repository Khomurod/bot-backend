'use strict';

/**
 * A Board ↔ Bitrix pass whose status sync did nothing is not a clean run
 * (docs/architecture/health-reporting.md: the pass decides, and says so in
 * `error`; one bad item among many is not a failed pass). Until 14 November
 * 2026 a pass whose every attempt failed — 157 on one deal — was recorded in
 * the run ledger as plain `ok`, and so was a sync that threw. And a person's
 * "done" still trusts a pass that COMPARED, even when its status sync failed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { syncFailure } = require('../services/boardBitrix/pass');
const { statusFromSummary } = require('../services/operations/runLedger');
const answer = require('../services/boardBitrix/answer');

test('every attempted update failing, or the sync throwing, makes the pass an error — with no deal or name in it', () => {
  const all = statusFromSummary({ compared: true, ...syncFailure({ failed: 2, applied: 0, alreadyDone: 0 }) });
  assert.equal(all.status, 'error');
  assert.equal(all.error, 'all 2 Bitrix status update(s) tried this pass failed or were refused — see Monitoring → Logs');

  const threw = statusFromSummary({ compared: true, ...syncFailure({ error: 'claim table unreachable at https://x.example/rest/1/abc/' }) });
  assert.equal(threw.status, 'error');
  assert.match(threw.error, /^the Bitrix status sync stopped before it finished: claim table unreachable/);
  assert.doesNotMatch(threw.error, /rest\/1\/abc|x\.example/, 'no URL or credential path reaches the health screens');
});

test('some failed while others went through is NOT a failed pass — the counts say it', () => {
  assert.deepEqual(syncFailure({ failed: 1, applied: 9, alreadyDone: 0 }), {});
  assert.deepEqual(syncFailure({ failed: 2, applied: 0, alreadyDone: 1 }), {});
  assert.deepEqual(syncFailure({ failed: 0, applied: 4 }), {});
  assert.deepEqual(syncFailure({ mode: 'off' }), {});
  assert.equal(statusFromSummary({ compared: true, syncFailed: 1, ...syncFailure({ failed: 1, applied: 9 }) }).status, 'ok');
});

test('a "done" re-check trusts a pass that compared even when its sync failed', async () => {
  const said = [];
  const outcome = await answer.recheck({ id: 5 }, async (line) => { said.push(line); }, {
    recheck: async () => ({ compared: true, error: '1 of 1 Bitrix status update(s) failed' }),
    store: { getDiscrepancy: async () => ({ id: 5, state: 'resolved', resolvedHow: 'confirmed' }) },
    askNext: async () => {},
  });
  assert.equal(outcome, 'confirmed');
  assert.doesNotMatch(said.join(' '), /could not check/);

  const failed = await answer.recheck({ id: 5 }, async (line) => { said.push(line); }, {
    recheck: async () => ({ error: 'Bitrix could not be read' }),
  });
  assert.equal(failed, 'recheck_failed');
});

test('an already-done transition is its own entry; a write that throws is recorded by the client, not twice', async () => {
  const { runStageSync } = require('../services/boardBitrix/stageSync');
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  const d = {
    kind: 'status_differs', key: 'k',
    board: {
      rowKey: 'r', status: 'HOME', statusChangedAt: new Date(NOW - 3600000), name: 'AL BO', fleetType: 'company', truck: '7',
    },
    deal: {
      id: 9, title: 'AL BO', stageId: 'C9:W', fleetType: 'company', truckNumber: '7',
    },
    expectedStageId: 'C9:H',
  };
  const schema = { categoryId: 9, stageByRole: { HOME: 'C9:H' }, writeSafe: true };
  const attempts = [];
  const base = {
    now: () => NOW, isLiveEnabled: async () => true, claim: async () => 1, finish: async () => {},
    confirmBoardStatus: async () => true, logAttempt: async (a) => { attempts.push(a); },
  };
  await runStageSync({
    discrepancies: [d], schema, mode: 'live',
    deps: { ...base, call: async () => ({ CATEGORY_ID: '9', STAGE_ID: 'C9:H' }) },
  });
  assert.deepEqual(attempts.map((a) => a.result), ['already_done']);
  assert.equal(attempts[0].audit.trigger, 'board_bitrix.sync');

  attempts.length = 0;
  const out = await runStageSync({
    discrepancies: [d], schema, mode: 'live',
    deps: {
      ...base,
      call: async (method) => {
        if (method === 'crm.deal.get') return { CATEGORY_ID: '9', STAGE_ID: 'C9:W' };
        throw new Error('Bitrix crm.deal.update: Access denied');
      },
    },
  });
  assert.equal(out.failed, 1);
  assert.deepEqual(attempts, [], 'the client records the failed write itself');
});
