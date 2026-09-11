/**
 * Accepting a suggestion, end to end, against the real schema.
 *
 * THE CLAIM UNDER TEST is the one that used to be false: after an
 * administrator accepts "switch automatic correction off for this check", the
 * check IS switched off — readable from `operational_check_settings`, which is
 * the table the correction engine actually consults. Before this, accepting
 * wrote the word "accepted" and the check kept correcting.
 *
 * And the other half, which matters just as much: a suggestion with nothing to
 * apply comes out of the same button as `accepted_manual`, with the settings
 * table untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['operationalLearning', 'operationalCheckSettings', 'adminAudit']);
  // eslint-disable-next-line global-require
  const decision = require('../services/operations/learningDecision');
  // eslint-disable-next-line global-require
  const actions = require('../services/operations/learningActions');
  return {
    h,
    decision,
    deps: {
      store: layer.operationalLearning,
      checkSettings: layer.operationalCheckSettings,
      audit: layer.adminAudit,
      actions,
    },
  };
}

const ADMIN = { id: null, username: 'boss', roleKeys: ['super_admin'], ip: '10.0.0.1' };

test('accepting a setting-shaped suggestion switches the check off for real',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, decision, deps } = await setup(t);

    await deps.checkSettings.upsertCheckSettings('home_time.closable_open_cycle', {
      autoApplyEnabled: true, maxAutoPerRun: 120, updatedBy: 'boss',
    });
    const row = await deps.store.upsertSuggestion({
      kind: 'reverted_correction',
      subjectId: 'home_time.close_cycle',
      title: '"home time close cycle" has been undone 3 times',
      suggestion: 'Consider switching automatic correction OFF for this check.',
      evidence: { count: 3 },
      applyAction: {
        action: 'disable_auto_apply',
        payload: { checkKeys: ['home_time.closable_open_cycle'] },
      },
    });

    const out = await decision.acceptSuggestion(row.id, { admin: ADMIN, deps });
    assert.equal(out.applied, true);
    assert.equal(out.suggestion.status, 'accepted_active');

    const settings = await h.query(
      "SELECT auto_apply_enabled, max_auto_per_run FROM operational_check_settings WHERE check_key = 'home_time.closable_open_cycle'"
    );
    assert.equal(settings.rows[0].auto_apply_enabled, false,
      'THE CHECK IS ACTUALLY OFF — this is the assertion the old behaviour could not make');
    assert.equal(settings.rows[0].max_auto_per_run, 120, 'and the cap it had is not reset');

    const audit = await h.query(
      "SELECT action, entity_type FROM admin_audit_log WHERE action LIKE 'learning.%'"
    );
    assert.equal(audit.rows[0].action, 'learning.apply.disable_auto_apply');
    assert.equal(audit.rows[0].entity_type, 'learning_suggestion');
  });

test('and one click puts it back, from what was recorded', { skip: skipWithoutPg() }, async (t) => {
  const { h, decision, deps } = await setup(t);
  await deps.checkSettings.upsertCheckSettings('a.check', {
    autoApplyEnabled: true, maxAutoPerRun: 77, updatedBy: 'boss',
  });
  const row = await deps.store.upsertSuggestion({
    kind: 'reverted_correction', subjectId: 'a.action', title: 't', suggestion: 's',
    applyAction: { action: 'disable_auto_apply', payload: { checkKeys: ['a.check'] } },
  });

  await decision.acceptSuggestion(row.id, { admin: ADMIN, deps });
  const out = await decision.revertSuggestion(row.id, { admin: ADMIN, deps });
  assert.equal(out.reverted, true);
  assert.equal(out.suggestion.status, 'reverted');

  const after = await h.query(
    "SELECT auto_apply_enabled, max_auto_per_run FROM operational_check_settings WHERE check_key = 'a.check'"
  );
  assert.equal(after.rows[0].auto_apply_enabled, true);
  assert.equal(after.rows[0].max_auto_per_run, 77);
});

test('a check that had NO row gets its absence back, not a FALSE',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, decision, deps } = await setup(t);
    const row = await deps.store.upsertSuggestion({
      kind: 'reverted_correction', subjectId: 'b.action', title: 't', suggestion: 's',
      applyAction: { action: 'disable_auto_apply', payload: { checkKeys: ['never.configured'] } },
    });

    await decision.acceptSuggestion(row.id, { admin: ADMIN, deps });
    assert.equal((await h.query(
      "SELECT COUNT(*)::int AS n FROM operational_check_settings WHERE check_key = 'never.configured'"
    )).rows[0].n, 1);

    await decision.revertSuggestion(row.id, { admin: ADMIN, deps });
    assert.equal((await h.query(
      "SELECT COUNT(*)::int AS n FROM operational_check_settings WHERE check_key = 'never.configured'"
    )).rows[0].n, 0, 'no row and a row saying FALSE are different things, and only one '
      + 'of them is a decision somebody took');
  });

test('a suggestion with nothing to apply is accepted_manual and touches nothing',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, decision, deps } = await setup(t);
    const row = await deps.store.upsertSuggestion({
      kind: 'recruiting_refusal', subjectId: 'unapproved_figure',
      title: "Wenze's answer to candidates was refused 4 times",
      suggestion: 'Adding the fact under Teach Wenze would let it answer instead of deferring.',
      applyAction: null,
    });

    // A snapshot rather than an emptiness check: a later migration may seed
    // rows here, and "nothing changed" is the claim, not "nothing exists".
    const before = await h.query(
      'SELECT check_key, auto_apply_enabled, max_auto_per_run FROM operational_check_settings ORDER BY check_key'
    );

    const out = await decision.acceptSuggestion(row.id, { admin: ADMIN, deps });
    assert.equal(out.applied, false);
    assert.equal(out.suggestion.status, 'accepted_manual');

    const after = await h.query(
      'SELECT check_key, auto_apply_enabled, max_auto_per_run FROM operational_check_settings ORDER BY check_key'
    );
    assert.deepEqual(after.rows, before.rows, 'agreement, and nothing else');
  });

test('the schema accepts every status the screen renders, and refuses one it does not',
  { skip: skipWithoutPg() }, async (t) => {
    const { h } = await setup(t);
    for (const status of ['proposed', 'accepted', 'accepted_active', 'accepted_manual', 'dismissed', 'reverted']) {
      // eslint-disable-next-line no-await-in-loop
      await h.query(
        `INSERT INTO operational_learning_suggestions (kind, subject_id, title, suggestion, status)
         VALUES ('k', $1, 't', 's', $2)`,
        [status, status]
      );
    }
    await assert.rejects(
      () => h.query(
        `INSERT INTO operational_learning_suggestions (kind, subject_id, title, suggestion, status)
         VALUES ('k', 'x', 't', 's', 'applied_itself')`
      ),
      /violates check constraint/
    );
  });

test('the apply payload is refreshed when the pattern changes, so acceptance cannot '
  + 'act on stale checks', { skip: skipWithoutPg() }, async (t) => {
  const { decision: _d, deps } = await setup(t);
  await deps.store.upsertSuggestion({
    kind: 'reverted_correction', subjectId: 'c.action', title: 't', suggestion: 's',
    applyAction: { action: 'disable_auto_apply', payload: { checkKeys: ['one.check'] } },
  });
  const updated = await deps.store.upsertSuggestion({
    kind: 'reverted_correction', subjectId: 'c.action', title: 't2', suggestion: 's2',
    applyAction: { action: 'disable_auto_apply', payload: { checkKeys: ['one.check', 'two.check'] } },
  });
  assert.deepEqual(updated.applyPayload, { checkKeys: ['one.check', 'two.check'] });
});
