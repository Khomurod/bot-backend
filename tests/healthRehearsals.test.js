'use strict';

/**
 * Whether a check in Suggest mode is writing down what it would have done can
 * be read from /api/health — counts and a timestamp, nothing else.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { getOperationsHealth } = require('../services/operations/healthSummary');
const { summaryDeps } = require('./helpers/operationsHealthDeps');

function withRehearsals(rehearsals) {
  const deps = summaryDeps();
  const base = deps.consistency.getConsistencyStatus();
  deps.consistency = { getConsistencyStatus: () => ({ ...base, rehearsals }) };
  return deps;
}

test('the last rehearsal pass is published as counts and a time', async () => {
  const s = await getOperationsHealth(withRehearsals({
    at: '2026-10-02T22:23:00.000Z', rehearsed: 41, checks: 3, extra: 'never published',
  }));
  assert.deepEqual(s.corrections.rehearsals, {
    at: '2026-10-02T22:23:00.000Z', rehearsed: 41, checks: 3,
  });
});

test('no rehearsal pass yet reads as null, not as zero', async () => {
  const s = await getOperationsHealth(withRehearsals(null));
  assert.equal(s.corrections.rehearsals, null);
});

test('the consistency status carries it from the rehearsal module', () => {
  const rehearsals = require('../services/operations/corrections/rehearsals');
  const { getConsistencyStatus } = require('../services/operations/consistencyService');
  rehearsals.resetRehearsalClock();
  assert.equal(getConsistencyStatus().rehearsals, null);
});
