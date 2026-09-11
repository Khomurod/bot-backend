'use strict';

/**
 * The batch reaching a decision, and recording it.
 *
 * `takeDecision` was written as "the one way a background check decides
 * something and the one way it is recorded", with nineteen passing tests and
 * NO PRODUCTION CALLER. Nothing ever wrote `operational_decisions`, so the
 * verification pass graded an empty table every hour and reported healthy, the
 * source-reliability model had no data and every source stayed unmeasured, and
 * the learning pass's third input was permanently empty. Four stages of
 * machinery hung off an entry point nobody called.
 *
 * THE RULE THESE TESTS ENFORCE ABOVE ALL OTHERS: routing corrections through
 * the journal must RECORD what they do, not quietly stop them. A safety
 * feature that silently disables a working repair is a regression wearing
 * better clothes, so the first tests here are about the corrections still
 * happening.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runAutoCorrections } = require('../services/operations/corrections/autoApply');
const { sourcesFor, MIN_CONFIDENCE } = require('../services/operations/corrections/decisionSeam');

const NOW = Date.now();
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

function finding(over = {}) {
  return {
    id: 1,
    checkKey: 'home_time.closable_open_cycle',
    subjectType: 'road_history',
    subjectId: '77',
    title: 'closable',
    severity: 'info',
    tier: 'auto',
    confidence: 95,
    lastSeenAt: minutesAgo(5),
    evidence: {},
    proposedChange: { id: 77, returnToRoadAt: { to: '2026-08-31T00:00:00Z' }, homeDays: { to: 6 } },
    ...over,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.mode      what the owner permitted for this check
 * @param {boolean} opts.shadow
 * @param {object} opts.decision  what the journal answers, or `throws`
 */
function harness({
  mode = 'autopilot', shadow = false, findings = [finding()],
  decision = null, journalThrows = false,
} = {}) {
  const calls = { decisions: [], applied: [], acted: [] };
  const db = {
    async query() {
      return {
        rows: [{
          check_key: 'home_time.closable_open_cycle',
          max_auto_per_run: 50, shadow, auto_apply_enabled: mode === 'autopilot', mode,
        }],
      };
    },
  };
  const store = {
    async countFindings({ checkKey }) {
      return checkKey === 'home_time.closable_open_cycle' ? findings.length : 0;
    },
    async listFindings({ checkKey }) {
      return checkKey === 'home_time.closable_open_cycle' ? findings : [];
    },
    async upsertFinding() { return { id: 99 }; },
  };
  const deps = {
    async takeDecision(ask) {
      calls.decisions.push(ask);
      if (journalThrows) throw new Error('connection terminated');
      const verdict = decision || { verdict: 'act', confidence: ask.confidence, reason: 'ok' };
      return {
        ...verdict,
        mayAct: verdict.verdict === 'act' && ask.shadow !== true,
        async acted(actionKey, correctionId) { calls.acted.push({ actionKey, correctionId }); },
      };
    },
  };
  return { db, store, deps, calls };
}

/**
 * The apply path, INJECTED rather than monkey-patched.
 *
 * `autoApply` destructures `applyCorrection` at module load, so reassigning the
 * other module's export has no effect whatever — a stub that silently does
 * nothing and a test that passes for the wrong reason. The batch takes it as a
 * dependency instead.
 */
function stubApply(deps, { throws = null } = {}) {
  const seen = [];
  deps.applyCorrection = async (args) => {
    seen.push(args);
    if (throws) throw throws;
    return {
      id: 500 + seen.length,
      subject_type: args.finding.subjectType,
      subject_id: args.finding.subjectId,
    };
  };
  return seen;
}

// ── the corrections still happen ─────────────────────────────────────────────

test('A PERMITTED, SCORED CORRECTION STILL APPLIES — the journal records, it does not block',
  async () => {
    const { db, store, deps, calls } = harness();
    const applied = stubApply(deps);

    const { summary } = await runAutoCorrections({ apply: true, db, store, deps });

    assert.equal(summary.applied, 1);
    assert.equal(summary.held, 0);
    assert.equal(applied.length, 1, 'the action really ran');
    assert.equal(calls.decisions.length, 1, 'and exactly one decision was recorded for it');
  });

test('A JOURNAL THAT CANNOT BE REACHED DOES NOT STOP A REPAIR', async (t) => {
  // The guardrails that actually protect this fleet — per-check permission, the
  // cap, and the action's own re-derivation under FOR UPDATE — all still hold.
  // A database blip silently switching off every automatic repair would be a
  // worse failure than an unrecorded one.
  const { db, store, deps } = harness({ journalThrows: true });
  const applied = stubApply(deps);

  const { summary } = await runAutoCorrections({ apply: true, db, store, deps });

  assert.equal(summary.applied, 1);
  assert.equal(applied.length, 1);
});

test('what was done is recorded against the decision that permitted it', async () => {
  const { db, store, deps, calls } = harness();
  stubApply(deps);
  await runAutoCorrections({ apply: true, db, store, deps });

  assert.equal(calls.acted.length, 1);
  assert.equal(calls.acted[0].actionKey, 'home_time.close_cycle');
  assert.equal(calls.acted[0].correctionId, 501, 'so the verification pass can grade this row later');
});

test('an action that fails records the decision but never claims it acted', async () => {
  const { db, store, deps, calls } = harness();
  stubApply(deps, { throws: new Error('deadlock detected') });

  const { summary } = await runAutoCorrections({ apply: true, db, store, deps });

  assert.equal(summary.failed, 1);
  assert.equal(calls.decisions.length, 1, 'the decision is still on the record');
  assert.equal(calls.acted.length, 0, 'and nothing says it was carried out');
});

// ── what the decision is asked ───────────────────────────────────────────────

test('THE MODE COMES FROM THE OWNER\'S SETTINGS ROW, not from having got this far',
  async () => {
    const { db, store, deps, calls } = harness({ mode: 'autopilot' });
    stubApply(deps);
    await runAutoCorrections({ apply: true, db, store, deps });
    assert.equal(calls.decisions[0].mode, 'autopilot');
    assert.equal(calls.decisions[0].shadow, false);
    assert.equal(calls.decisions[0].minConfidence, MIN_CONFIDENCE);
    assert.equal(calls.decisions[0].confidence, 95, "the finding's own score, unchanged");
  });

test('the source is named per CHECK, which is what makes reliability mean anything', async () => {
  const { db, store, deps, calls } = harness();
  stubApply(deps);
  await runAutoCorrections({ apply: true, db, store, deps });

  const [source] = calls.decisions[0].sources;
  assert.equal(source.source, 'check:home_time.closable_open_cycle',
    'one shared source name would make the feedback fleet-wide and useless');
  assert.equal(source.agrees, true);
  assert.equal(calls.decisions[0].sources.length, 1,
    'one reading is one source — inflating it would make agreement look like corroboration');
});

test('A FINDING NOBODY HAS RE-DERIVED IN HOURS IS STALE EVIDENCE', () => {
  const fresh = sourcesFor(finding({ lastSeenAt: minutesAgo(30) }), NOW);
  assert.equal(fresh[0].fresh, true);

  const old = sourcesFor(finding({ lastSeenAt: minutesAgo(60 * 5) }), NOW);
  assert.equal(old[0].fresh, false,
    'the sweep re-derives every open finding every 15 minutes; five hours means it stopped');

  const never = sourcesFor(finding({ lastSeenAt: null }), NOW);
  assert.equal(never[0].fresh, false, 'and an unreadable timestamp is not a fresh one');
});

// ── a verdict that is not `act` ──────────────────────────────────────────────

test('a held decision changes nothing, and is counted apart from "not enabled"', async () => {
  const { db, store, deps } = harness({
    decision: { verdict: 'hold', confidence: 40, reason: 'confidence 40 is under the 70 this check acts on' },
  });
  const applied = stubApply(deps);

  const { summary, results } = await runAutoCorrections({ apply: true, db, store, deps });

  assert.equal(summary.applied, 0);
  assert.equal(summary.held, 1);
  assert.equal(summary.skipped.disabled, 0,
    'the owner DID enable this — "not permitted" and "not supported by the evidence" '
    + 'are different sentences');
  assert.equal(applied.length, 0);
  assert.match(results[0].error, /under the 70/);
});

// ── shadow ───────────────────────────────────────────────────────────────────

test('SHADOW RECORDS WHAT IT WOULD HAVE DONE — a count was not the trial\'s output',
  async (t) => {
    // This branch returned a bare number and read nothing, so a shadowed check
    // recorded NOTHING about what it would have changed: the one thing shadow
    // mode exists to produce.
    const { db, store, deps, calls } = harness({ shadow: true });
    const applied = stubApply(deps);

    const { summary } = await runAutoCorrections({ apply: true, db, store, deps });

    assert.equal(applied.length, 0, 'and it still applies nothing');
    assert.equal(summary.applied, 0);
    assert.equal(summary.skipped.shadowed, 1);
    assert.equal(calls.decisions.length, 1, 'but the decision is on the record');
    assert.equal(calls.decisions[0].shadow, true);
    assert.ok(calls.decisions[0].wouldHave, 'with what it would have changed');
    assert.equal(calls.decisions[0].wouldHave.actionKey, 'home_time.close_cycle');
    assert.match(calls.decisions[0].wouldHave.describe, /\w/, 'in the action\'s own words');
  });

test('a shadowed check is still reported apart from a disabled one', async () => {
  const shadowed = harness({ shadow: true });
  stubApply(shadowed.deps);
  const a = await runAutoCorrections({ apply: true, ...shadowed });
  assert.equal(a.summary.skipped.shadowed, 1);
  assert.equal(a.summary.skipped.disabled, 0);

  const off = harness({ mode: 'suggest' });
  const b = await runAutoCorrections({ apply: true, ...off });
  assert.equal(b.summary.skipped.shadowed, 0);
  assert.equal(b.summary.skipped.disabled, 1);
});

test('a dry run decides nothing and records nothing', async () => {
  const { db, store, deps, calls } = harness();
  const { summary } = await runAutoCorrections({ apply: false, db, store, deps });
  assert.equal(summary.dryRun, true);
  assert.equal(calls.decisions.length, 0,
    'a plan somebody is reading is not a decision Wenze took');
});
