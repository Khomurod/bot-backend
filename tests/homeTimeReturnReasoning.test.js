/**
 * What a model is allowed to do with the return-to-road evidence.
 *
 * The rule that matters: AI can agree with arithmetic, and it can disagree with
 * anything, but it cannot supply the fact that makes an automatic state change
 * possible. `movementProven` comes from coordinates and timestamps; a model
 * saying "yes he left" over a truck parked in its own driveway changes nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { reviewReturnEvidence, buildPrompt, CAPABILITY } = require('../services/homeTime/returnReasoning');

const MEDIUM = {
  confidence: 'medium',
  score: 60,
  signals: ['active_load'],
  blockers: ['no_gps'],
  summary: 'active load + no GPS available',
  facts: { hasLoad: true, movementProven: false, parkedAtHome: false, gpsFresh: false },
};
const MEDIUM_MOVED = {
  ...MEDIUM,
  blockers: [],
  facts: { hasLoad: true, movementProven: true, parkedAtHome: false, gpsFresh: true },
};

function deps({ returned = true, confidence = 90, throws = null, enabled = true } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      async isCapabilityEnabled(key) { calls.push({ gate: key }); return enabled; },
      async runCapability(args) {
        calls.push({ capability: args.capability, expects: args.expects, text: args.userText });
        if (throws) throw new Error(throws);
        return { parsed: { returned, confidence, reason: 'the truck is moving toward the pickup' } };
      },
    },
  };
}

test('only a medium verdict is ever put to a model', async () => {
  const d = deps();
  for (const confidence of ['high', 'low']) {
    // eslint-disable-next-line no-await-in-loop
    const out = await reviewReturnEvidence({ verdict: { ...MEDIUM, confidence } }, d.deps);
    assert.equal(out, null);
  }
  assert.equal(d.calls.length, 0, 'no gate check, no call, no cost');
});

test('a model may raise a case only when the coordinates already proved movement', async () => {
  const agreeing = deps({ returned: true, confidence: 95 });
  const blocked = await reviewReturnEvidence({ verdict: MEDIUM }, agreeing.deps);
  assert.equal(blocked, null, 'no proven movement → the model cannot supply it');

  const allowed = await reviewReturnEvidence({ verdict: MEDIUM_MOVED }, agreeing.deps);
  assert.equal(allowed.confidence, 'high');
  assert.ok(allowed.signals.includes('ai_agreed'));
  assert.equal(allowed.aiAssisted, true);
});

test('a model that is only somewhat sure does not raise anything', async () => {
  const d = deps({ returned: true, confidence: 55 });
  const out = await reviewReturnEvidence({ verdict: MEDIUM_MOVED }, d.deps);
  assert.equal(out, null);
});

test('a truck parked at home can never be talked into a departure', async () => {
  const d = deps({ returned: true, confidence: 99 });
  const parked = { ...MEDIUM_MOVED, facts: { ...MEDIUM_MOVED.facts, parkedAtHome: true } };
  assert.equal(await reviewReturnEvidence({ verdict: parked }, d.deps), null);
});

test('a model may always stand a case down', async () => {
  const d = deps({ returned: false });
  const out = await reviewReturnEvidence({ verdict: MEDIUM_MOVED }, d.deps);
  assert.equal(out.confidence, 'low');
  assert.ok(out.blockers.includes('ai_disagreed'));
});

test('switching the capability off means no call at all', async () => {
  const d = deps({ enabled: false });
  assert.equal(await reviewReturnEvidence({ verdict: MEDIUM_MOVED }, d.deps), null);
  assert.equal(d.calls.filter((c) => c.capability).length, 0);
});

test('a failed call leaves the deterministic verdict alone', async () => {
  const d = deps({ throws: 'every provider failed' });
  assert.equal(await reviewReturnEvidence({ verdict: MEDIUM_MOVED }, d.deps), null);
});

test('the call is labelled with its business capability, not left unnamed', async () => {
  const d = deps();
  await reviewReturnEvidence({ verdict: MEDIUM_MOVED }, d.deps);
  const call = d.calls.find((c) => c.capability);
  assert.equal(call.capability, CAPABILITY);
  assert.equal(call.capability, 'home_time_return_to_road');
  assert.equal(call.expects, 'json');
});

test('the prompt carries facts and no identities', () => {
  const text = buildPrompt({
    verdict: MEDIUM_MOVED,
    load: { pickupTime: '2026-09-20T13:00:00Z' },
    homeHours: 72,
  });
  assert.match(text, /has an active load: true/);
  assert.match(text, /A load assigned to a driver who is still at home is normal planning/);
  for (const forbidden of ['name', 'chat', 'telegram', 'lat', 'lng', 'phone']) {
    assert.equal(new RegExp(forbidden, 'i').test(text), false, `${forbidden} must not be in the prompt`);
  }
});
