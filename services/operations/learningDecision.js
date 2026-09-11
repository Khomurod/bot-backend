'use strict';

/**
 * What accepting a suggestion actually does.
 *
 * THE ONE DECISION THIS FILE MAKES, and everything else follows from it: a
 * suggestion either names a CONFIGURABLE SETTING or it does not, and the two
 * must never look the same to the person clicking Accept.
 *
 *   It names one → the setting is changed, the old value is recorded, the row
 *   reads `accepted_active`, and one click puts it back.
 *
 *   It does not → the row reads `accepted_manual` and the screen says, in
 *   words, that agreement was recorded and somebody still has to do the thing.
 *
 * Before this existed, accepting wrote a word in a table and changed nothing,
 * while the UI said "accepted". An administrator who accepted "switch automatic
 * correction off for this check" believed they had switched it off; the check
 * kept correcting. That is worse than not offering the button.
 *
 * WHAT IT CANNOT DO. The action is looked up in
 * `services/operations/learningActions.js`, which holds exactly one — turn a
 * check's automatic correction OFF. There is no action that turns anything on,
 * and none that touches pay, employment, hiring, start dates, safety
 * discipline, a driver's record, or code. A suggestion naming an action the
 * registry does not know is REFUSED rather than degraded to "accepted", because
 * silently downgrading is how a person ends up believing something happened.
 *
 * EVERY APPLICATION AND EVERY REVERT WRITES `admin_audit_log`, through the same
 * helper and redactor the correction engine uses, so there stays exactly one
 * place a human looks for "what changed, who did it, why".
 */

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/operationalLearning'),
    checkSettings: require('../../database/operationalCheckSettings'),
    audit: require('../../database/adminAudit'),
    actions: require('./learningActions'),
  };
  /* eslint-enable global-require */
}

/** The decision, ready to render, without running anything. */
function describeDecision(suggestion, deps = defaultDeps()) {
  const action = suggestion?.applyAction
    ? deps.actions.getLearningAction(suggestion.applyAction)
    : null;
  if (!suggestion?.applyAction) {
    return {
      applicable: false,
      willDo: 'Nothing will change automatically. Accepting records that you agree; '
        + 'somebody still has to carry it out.',
    };
  }
  if (!action) {
    return {
      applicable: false,
      unknownAction: true,
      willDo: 'This suggestion names a change Wenze does not know how to make safely. '
        + 'Accepting records agreement only.',
    };
  }
  return { applicable: true, willDo: action.describe(suggestion.applyPayload) };
}

/**
 * Accept a suggestion.
 *
 * @param {number} id
 * @param {{admin: object, note?: string|null, deps?: object}} context
 * @returns {Promise<{suggestion: object, applied: boolean, detail: string}>}
 */
async function acceptSuggestion(id, { admin = null, note = null, deps = defaultDeps() } = {}) {
  const actor = admin?.username || 'an administrator';
  const suggestion = await deps.store.getSuggestionById(id);
  if (!suggestion) return null;

  const action = suggestion.applyAction
    ? deps.actions.getLearningAction(suggestion.applyAction)
    : null;

  // No action, or one this build does not know: agreement, recorded as such.
  // NEVER as `accepted_active` — a status that claims a change that did not
  // happen is the defect this module was written to remove.
  if (!action) {
    const row = await deps.store.decideSuggestion(id, {
      status: 'accepted_manual', decidedBy: actor, note,
    });
    await deps.audit.insertAdminAudit({
      adminId: admin?.id ?? null,
      roleKeys: admin?.roleKeys || null,
      action: 'learning.accept_manual',
      entityType: 'learning_suggestion',
      entityId: String(id),
      newValues: { status: 'accepted_manual' },
      reason: note || suggestion.title,
      ipAddress: admin?.ip || null,
    }).catch(() => {});
    return {
      suggestion: row,
      applied: false,
      detail: suggestion.applyAction
        ? 'Agreement recorded. Wenze does not know how to make this change safely, '
          + 'so nothing was altered.'
        : 'Agreement recorded. Nothing was changed automatically — this one is for a person to do.',
    };
  }

  const result = await action.apply(suggestion.applyPayload, { ...deps, actor });
  const row = await deps.store.recordSuggestionApplied(id, {
    action: action.key, before: result.before, appliedBy: actor,
  });
  await deps.audit.insertAdminAudit({
    adminId: admin?.id ?? null,
    roleKeys: admin?.roleKeys || null,
    action: `learning.apply.${action.key}`,
    entityType: 'learning_suggestion',
    entityId: String(id),
    oldValues: result.before,
    newValues: result.after,
    reason: note || suggestion.title,
    ipAddress: admin?.ip || null,
  }).catch(() => {});

  return {
    suggestion: row,
    applied: true,
    detail: result.changed
      ? action.describe(suggestion.applyPayload)
      : 'It was already set that way; nothing needed changing.',
  };
}

/**
 * Undo an accepted suggestion.
 *
 * Restores from `applied_before` — what was ACTUALLY there — rather than from a
 * default. A check that had no settings row at all gets its absence back, not a
 * FALSE somebody could later read as a decision.
 */
async function revertSuggestion(id, { admin = null, note = null, deps = defaultDeps() } = {}) {
  const actor = admin?.username || 'an administrator';
  const suggestion = await deps.store.getSuggestionById(id);
  if (!suggestion) return null;
  if (!suggestion.appliedAt || suggestion.revertedAt) {
    return { suggestion, reverted: false, detail: 'There is nothing applied to undo.' };
  }

  const action = deps.actions.getLearningAction(suggestion.applyAction);
  if (!action) {
    return {
      suggestion,
      reverted: false,
      detail: 'This build does not know the action that was applied, so it will not guess '
        + 'at how to undo it.',
    };
  }

  const result = await action.revert(suggestion.appliedBefore, { ...deps, actor });
  const row = await deps.store.recordSuggestionReverted(id, { revertedBy: actor, note });
  await deps.audit.insertAdminAudit({
    adminId: admin?.id ?? null,
    roleKeys: admin?.roleKeys || null,
    action: `learning.revert.${action.key}`,
    entityType: 'learning_suggestion',
    entityId: String(id),
    oldValues: { applied: true },
    newValues: suggestion.appliedBefore,
    reason: note || 'reverted',
    ipAddress: admin?.ip || null,
  }).catch(() => {});

  return { suggestion: row, reverted: true, detail: `${result.restored} setting(s) put back.` };
}

module.exports = { defaultDeps, describeDecision, acceptSuggestion, revertSuggestion };
