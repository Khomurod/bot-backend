/**
 * What accepting a suggestion actually does — and what it says when it does
 * nothing.
 *
 * THE DEFECT THIS CLOSES. An administrator marked a suggestion `accepted` and
 * nothing happened; the UI said "accepted" either way. Somebody who accepted
 * "switch automatic correction off for this check" reasonably believed they had
 * switched it off. They had written a word in a table, and the check kept
 * correcting. That is worse than not offering the button, because it produces
 * false confidence rather than an obvious gap.
 *
 * The two states must never be confusable, which is what most of this file
 * asserts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const decision = require('../services/operations/learningDecision');
const actions = require('../services/operations/learningActions');

const SUGGESTION = {
  id: 4,
  kind: 'reverted_correction',
  title: '"home time close cycle" has been undone 3 times',
  applyAction: 'disable_auto_apply',
  applyPayload: { checkKeys: ['home_time.closable_open_cycle'] },
  status: 'proposed',
};

function harness({ suggestion = SUGGESTION, settings = [] } = {}) {
  const saw = { decided: [], applied: [], reverted: [], audits: [], upserts: [], deletes: [] };
  const state = new Map(settings.map((s) => [s.checkKey, { ...s }]));
  const deps = {
    store: {
      async getSuggestionById() { return suggestion; },
      async decideSuggestion(id, args) { saw.decided.push({ id, ...args }); return { ...suggestion, ...args }; },
      async recordSuggestionApplied(id, args) {
        saw.applied.push({ id, ...args });
        return { ...suggestion, status: 'accepted_active', appliedBefore: args.before };
      },
      async recordSuggestionReverted(id, args) {
        saw.reverted.push({ id, ...args });
        return { ...suggestion, status: 'reverted' };
      },
    },
    checkSettings: {
      async listCheckSettings() { return [...state.values()]; },
      async upsertCheckSettings(key, args) { saw.upserts.push({ key, ...args }); state.set(key, { checkKey: key, ...args }); },
      async deleteCheckSettings(key) { saw.deletes.push(key); state.delete(key); },
    },
    audit: { async insertAdminAudit(entry) { saw.audits.push(entry); } },
    actions,
  };
  return { deps, saw };
}

const ADMIN = { id: 9, username: 'boss', roleKeys: ['super_admin'], ip: '10.0.0.1' };

test('accepting a suggestion that names a setting ACTUALLY CHANGES IT', async () => {
  const { deps, saw } = harness({
    settings: [{ checkKey: 'home_time.closable_open_cycle', autoApplyEnabled: true, maxAutoPerRun: 50 }],
  });
  const out = await decision.acceptSuggestion(4, { admin: ADMIN, deps });

  assert.equal(out.applied, true);
  assert.equal(out.suggestion.status, 'accepted_active');
  assert.equal(saw.upserts[0].autoApplyEnabled, false,
    'the check is switched off — which is what the administrator thought they were doing');
});

test('the OLD value is recorded, so the undo restores a fact rather than a guess', async () => {
  const { deps, saw } = harness({
    settings: [{ checkKey: 'home_time.closable_open_cycle', autoApplyEnabled: true, maxAutoPerRun: 120 }],
  });
  await decision.acceptSuggestion(4, { admin: ADMIN, deps });
  assert.deepEqual(saw.applied[0].before['home_time.closable_open_cycle'],
    { present: true, autoApplyEnabled: true, maxAutoPerRun: 120 });
});

test('a suggestion with NOTHING to apply says so, and never claims otherwise', async () => {
  const { deps, saw } = harness({
    suggestion: { ...SUGGESTION, applyAction: null, applyPayload: null },
  });
  const out = await decision.acceptSuggestion(4, { admin: ADMIN, deps });

  assert.equal(out.applied, false);
  assert.equal(saw.decided[0].status, 'accepted_manual',
    'NOT accepted_active — a status claiming a change that did not happen is the '
    + 'whole defect being fixed');
  assert.match(out.detail, /for a person to do/);
  assert.deepEqual(saw.upserts, [], 'and nothing was written');
});

test('an action this build does not know is refused, not quietly downgraded to success', async () => {
  const { deps, saw } = harness({
    suggestion: { ...SUGGESTION, applyAction: 'rewrite_the_pay_scale' },
  });
  const out = await decision.acceptSuggestion(4, { admin: ADMIN, deps });
  assert.equal(out.applied, false);
  assert.equal(saw.decided[0].status, 'accepted_manual');
  assert.match(out.detail, /does not know how to make this change safely/);
  assert.deepEqual(saw.upserts, []);
});

test('every acceptance is audited, with who and why', async () => {
  const { deps, saw } = harness({
    settings: [{ checkKey: 'home_time.closable_open_cycle', autoApplyEnabled: true, maxAutoPerRun: 50 }],
  });
  await decision.acceptSuggestion(4, { admin: ADMIN, note: 'it keeps picking the wrong cycle', deps });

  const entry = saw.audits[0];
  assert.equal(entry.action, 'learning.apply.disable_auto_apply');
  assert.equal(entry.adminId, 9);
  assert.equal(entry.entityType, 'learning_suggestion');
  assert.equal(entry.reason, 'it keeps picking the wrong cycle');
  assert.ok(entry.oldValues, 'the audit carries what it replaced');
});

test('accepting one that needs a person is audited too — agreement is a decision', async () => {
  const { deps, saw } = harness({ suggestion: { ...SUGGESTION, applyAction: null } });
  await decision.acceptSuggestion(4, { admin: ADMIN, deps });
  assert.equal(saw.audits[0].action, 'learning.accept_manual');
});

// ── undoing ─────────────────────────────────────────────────────────────────

test('reverting puts back exactly what was recorded', async () => {
  const { deps, saw } = harness({
    suggestion: {
      ...SUGGESTION,
      status: 'accepted_active',
      appliedAt: '2026-09-20T10:00:00Z',
      appliedBefore: {
        'home_time.closable_open_cycle': { present: true, autoApplyEnabled: true, maxAutoPerRun: 120 },
      },
    },
  });
  const out = await decision.revertSuggestion(4, { admin: ADMIN, deps });

  assert.equal(out.reverted, true);
  assert.equal(saw.upserts[0].autoApplyEnabled, true);
  assert.equal(saw.upserts[0].maxAutoPerRun, 120);
  assert.equal(saw.audits[0].action, 'learning.revert.disable_auto_apply');
});

test('a check that had NO row gets its absence back', async () => {
  const { deps, saw } = harness({
    suggestion: {
      ...SUGGESTION,
      appliedAt: '2026-09-20T10:00:00Z',
      appliedBefore: { 'load.phase_unclear': { present: false } },
    },
  });
  await decision.revertSuggestion(4, { admin: ADMIN, deps });
  assert.deepEqual(saw.deletes, ['load.phase_unclear']);
  assert.deepEqual(saw.upserts, []);
});

test('there is nothing to undo on a suggestion that was never applied', async () => {
  const { deps, saw } = harness();
  const out = await decision.revertSuggestion(4, { admin: ADMIN, deps });
  assert.equal(out.reverted, false);
  assert.match(out.detail, /nothing applied to undo/);
  assert.deepEqual(saw.upserts, []);
});

test('an already-reverted suggestion is not reverted twice', async () => {
  const { deps } = harness({
    suggestion: {
      ...SUGGESTION, appliedAt: '2026-09-20T10:00:00Z', revertedAt: '2026-09-20T11:00:00Z',
    },
  });
  assert.equal((await decision.revertSuggestion(4, { admin: ADMIN, deps })).reverted, false);
});

// ── what the screen is told before anybody clicks ───────────────────────────

test('the screen can say what accepting WILL do, before it happens', () => {
  const { deps } = harness();
  const d = decision.describeDecision(SUGGESTION, deps);
  assert.equal(d.applicable, true);
  assert.match(d.willDo, /switched off for home_time\.closable_open_cycle/);
});

test('and it says plainly when accepting will change nothing', () => {
  const { deps } = harness();
  const d = decision.describeDecision({ ...SUGGESTION, applyAction: null }, deps);
  assert.equal(d.applicable, false);
  assert.match(d.willDo, /somebody still has to carry it out/);
});

test('a missing suggestion is null, not a pretend success', async () => {
  const { deps } = harness({ suggestion: null });
  assert.equal(await decision.acceptSuggestion(99, { admin: ADMIN, deps }), null);
  assert.equal(await decision.revertSuggestion(99, { admin: ADMIN, deps }), null);
});
