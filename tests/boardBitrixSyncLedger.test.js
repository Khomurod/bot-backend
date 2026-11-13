'use strict';

/**
 * A Board ↔ Bitrix pass whose status updates failed is not a clean run
 * (docs/architecture/health-reporting.md: the pass says so in `error`). Until
 * 14 November 2026 a pass with 157 failed attempts on one deal was recorded
 * in the run ledger as plain `ok`. And a person's "done" still trusts a pass
 * that COMPARED, even when its status sync failed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { syncFailure } = require('../services/boardBitrix/pass');
const { statusFromSummary } = require('../services/operations/runLedger');
const answer = require('../services/boardBitrix/answer');

test('failed status updates make the pass an error in the ledger, with no deal or name in it', () => {
  const summary = { compared: true, syncApplied: 1, ...syncFailure({ failed: 2, applied: 1, alreadyDone: 0 }) };
  const { status, error } = statusFromSummary(summary);
  assert.equal(status, 'error');
  assert.equal(error, '2 of 3 Bitrix status update(s) failed or were refused this pass — see Monitoring → Logs');
  assert.deepEqual(syncFailure({ failed: 0, applied: 4 }), {});
  assert.equal(statusFromSummary({ compared: true, ...syncFailure({ failed: 0 }) }).status, 'ok');
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
