'use strict';

/**
 * A check in Suggest mode writes down what it would have done — and nothing
 * else does, and nothing is applied.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  recordRehearsals, resetRehearsalClock, getRehearsalStatus, PER_CHECK, EVERY_MS,
} = require('../services/operations/corrections/rehearsals');

function harness({ modes = {}, findings = {}, failFor = null } = {}) {
  const calls = { recorded: [], listed: [] };
  const settings = new Map(Object.entries(modes).map(([k, mode]) => [k, { mode }]));
  return {
    calls,
    args: {
      settings,
      store: {
        async listFindings(q) {
          calls.listed.push(q);
          return (findings[q.checkKey] || []).slice(0, q.limit);
        },
      },
      checkKeys: Object.keys(modes),
      actionFor: (k) => (k === 'no.action' ? null : { key: `${k}.fix` }),
      payloadFor: (f) => (f.noPayload ? null : { id: f.id }),
      modeOf: (s) => (s ? s.mode : null),
      floorFor: () => 70,
      recordDecisionFor: async (item, opts) => {
        if (failFor === item.finding.id) throw new Error('journal down');
        calls.recorded.push({ item, opts });
        return { verdict: 'suggest', mayAct: false };
      },
      takeDecision: async () => ({}),
    },
  };
}

const many = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

test('only a check in Suggest rehearses — not Observe, not Autopilot', async () => {
  resetRehearsalClock();
  const { args, calls } = harness({
    modes: { 'a.suggest': 'suggest', 'b.observe': 'observe', 'c.autopilot': 'autopilot' },
    findings: { 'a.suggest': many(2), 'b.observe': many(2), 'c.autopilot': many(2) },
  });
  const out = await recordRehearsals({ ...args, now: 1_000 });
  assert.strictEqual(out.rehearsed, 2);
  assert.strictEqual(out.checks, 1);
  assert.deepStrictEqual(calls.listed.map((q) => q.checkKey), ['a.suggest']);
  for (const { item, opts } of calls.recorded) {
    assert.strictEqual(item.mode, 'suggest', 'journalled in the mode the owner chose');
    assert.strictEqual(opts.shadow, false);
    assert.strictEqual(opts.minConfidence, 70);
  }
});

test('only open auto-tier findings, at most PER_CHECK of them', async () => {
  resetRehearsalClock();
  const { args, calls } = harness({
    modes: { 'a.suggest': 'suggest' }, findings: { 'a.suggest': many(PER_CHECK + 10) },
  });
  const out = await recordRehearsals({ ...args, now: 1_000 });
  assert.strictEqual(out.rehearsed, PER_CHECK);
  assert.deepStrictEqual(calls.listed[0], {
    status: 'open', checkKey: 'a.suggest', tier: 'auto', limit: PER_CHECK,
  });
});

test('at most once every six hours', async () => {
  resetRehearsalClock();
  const { args } = harness({ modes: { 'a.suggest': 'suggest' }, findings: { 'a.suggest': many(1) } });
  assert.strictEqual((await recordRehearsals({ ...args, now: 1_000 })).rehearsed, 1);
  const soon = await recordRehearsals({ ...args, now: 1_000 + EVERY_MS - 1 });
  assert.strictEqual(soon.skipped, 'recently');
  assert.strictEqual(soon.rehearsed, 0);
  assert.strictEqual((await recordRehearsals({ ...args, now: 1_000 + EVERY_MS })).rehearsed, 1);
});

test('no action, no payload, or a journal that fails costs that one finding only', async () => {
  resetRehearsalClock();
  const { args } = harness({
    modes: { 'a.suggest': 'suggest', 'no.action': 'suggest' },
    findings: {
      'a.suggest': [{ id: 1 }, { id: 2, noPayload: true }, { id: 3 }, { id: 4 }],
      'no.action': many(3),
    },
    failFor: 3,
  });
  const out = await recordRehearsals({ ...args, now: 1_000 });
  assert.strictEqual(out.rehearsed, 2, 'findings 1 and 4');
});

test('the last pass that RAN is what health reads — a throttled pass does not overwrite it', async () => {
  resetRehearsalClock();
  assert.equal(getRehearsalStatus(), null);
  const { args } = harness({ modes: { 'a.suggest': 'suggest' }, findings: { 'a.suggest': many(3) } });
  await recordRehearsals({ ...args, now: Date.parse('2026-10-02T22:00:00Z') });
  assert.deepEqual(getRehearsalStatus(), { at: '2026-10-02T22:00:00.000Z', rehearsed: 3, checks: 1 });
  await recordRehearsals({ ...args, now: Date.parse('2026-10-02T22:15:00Z') });
  assert.equal(getRehearsalStatus().rehearsed, 3, 'still the pass that wrote something');
});
