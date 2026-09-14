'use strict';

/**
 * The only things accepting a suggestion is allowed to change.
 *
 * WHAT WAS WRONG. An administrator marked a suggestion `accepted` and nothing
 * happened. The route's own comment said so and treated it as the safety
 * property; it is half of one. The guarantee worth keeping is that AI cannot
 * change a business rule BY ITSELF, and that is kept by requiring a person's
 * confirmation — not by making the confirmation inert. Somebody who accepted
 * "switch automatic correction off for this check" reasonably believed they had
 * switched it off. They had written a word in a table. The check kept
 * correcting.
 *
 * THE REGISTRY IS THE BOUNDARY. An action can only exist here, and there is
 * exactly one: turn a check's automatic correction off. That is a row in
 * `operational_check_settings` — a setting whose whole purpose is to be
 * toggled, whose previous value is recorded before it changes, and which one
 * click puts back.
 *
 * WHAT MAY NEVER BE IN HERE, stated so a future addition has to argue with it:
 * pay, employment status, hiring or rejection, start dates, promised equipment,
 * safety discipline or any punishment, a driver's record, and application code.
 * `tests/learningActions.test.js` asserts the registry's shape rather than
 * trusting this paragraph.
 *
 * A SUGGESTION WITH NO ACTION IS NOT A FAILURE. Most of them have none — "add
 * this fact under Teach Wenze", "reword an approved boundary" — and for those,
 * accepting means "yes, and somebody still has to do it". Saying that plainly
 * is the difference between a system that learns and one that files agreement.
 */

/** Every action key. A suggestion naming anything else is refused. */
const ACTIONS = Object.freeze({
  /**
   * Stop a check applying its own corrections. It keeps running and keeps
   * filing findings; it just proposes instead of repairing.
   *
   * This is the conservative direction by construction: it can only ever turn
   * automation OFF. There is deliberately no `enable_auto_apply` — a machine
   * proposing that it be trusted with more is the exact shape nobody should
   * build, however many confirmations sit in front of it.
   */
  DISABLE_AUTO_APPLY: 'disable_auto_apply',

  /**
   * Raise the confidence a check needs before it acts on its own.
   *
   * CONSERVATIVE BY CONSTRUCTION, in the same way and for the same reason as
   * the action above: `operational_check_settings.min_confidence` is CHECKed in
   * the database to 70–95, and 70 is the global floor. So this can only ever
   * make a check more cautious. A value that would grant more autonomy cannot
   * be stored — not by this action, not by a route, not by a later refactor
   * that forgets why.
   *
   * There is deliberately no `lower_confidence_floor`. A check that looks too
   * strict is worth saying out loud and the learning pass says it, with no
   * action attached: loosening a safety margin is a person's decision, taken in
   * the settings screen, with their name on it.
   */
  RAISE_CONFIDENCE_FLOOR: 'raise_confidence_floor',
});

const REGISTRY = {
  [ACTIONS.DISABLE_AUTO_APPLY]: {
    key: ACTIONS.DISABLE_AUTO_APPLY,
    /** What the screen says the button will do, in a sentence. */
    describe(payload) {
      const keys = payload?.checkKeys || [];
      return keys.length === 1
        ? `Automatic correction will be switched off for ${keys[0]}. It will keep `
          + 'finding the problem and propose instead of repairing.'
        : `Automatic correction will be switched off for ${keys.length} checks. They `
          + 'will keep finding problems and propose instead of repairing.';
    },
    /**
     * @returns {Promise<{before: object, after: object, changed: number}>}
     *   `before` is what was actually there, so the revert restores a real
     *   value rather than a default somebody assumed.
     */
    async apply(payload, deps) {
      const keys = [...new Set((payload?.checkKeys || []).map(String).filter(Boolean))];
      if (!keys.length) throw new Error('The suggestion names no check to change.');

      // `deps.client` joins the caller's transaction when there is one. A
      // payload naming several checks must be all-or-nothing: half of them
      // switched off with the suggestion still reading `proposed` is a state
      // nobody can reason about afterwards.
      const existing = await deps.checkSettings.listCheckSettings(deps.client || null);
      const byKey = new Map(existing.map((s) => [s.checkKey, s]));

      const before = {};
      let changed = 0;
      for (const key of keys) {
        const prior = byKey.get(key);
        // A check with NO ROW is already disabled — that is the seeding rule —
        // so it is recorded as absent and, on revert, deleted rather than set
        // back to a value it never had.
        before[key] = prior
          ? { present: true, autoApplyEnabled: prior.autoApplyEnabled, maxAutoPerRun: prior.maxAutoPerRun }
          : { present: false };
        if (prior && prior.autoApplyEnabled === false) continue;
        // eslint-disable-next-line no-await-in-loop
        await deps.checkSettings.upsertCheckSettings(key, {
          autoApplyEnabled: false,
          maxAutoPerRun: prior?.maxAutoPerRun ?? null,
          updatedBy: deps.actor || 'an administrator',
        }, deps.client || null);
        changed += 1;
      }
      return { before, after: { autoApplyEnabled: false, checkKeys: keys }, changed };
    },

    /** Put back exactly what `before` recorded, and nothing else. */
    async revert(before, deps) {
      let restored = 0;
      for (const [key, prior] of Object.entries(before || {})) {
        if (!prior?.present) {
          // eslint-disable-next-line no-await-in-loop
          await deps.checkSettings.deleteCheckSettings(key, deps.client || null);
          restored += 1;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await deps.checkSettings.upsertCheckSettings(key, {
          autoApplyEnabled: prior.autoApplyEnabled === true,
          maxAutoPerRun: prior.maxAutoPerRun ?? null,
          updatedBy: deps.actor || 'an administrator',
        }, deps.client || null);
        restored += 1;
      }
      return { restored };
    },
  },

  [ACTIONS.RAISE_CONFIDENCE_FLOOR]: {
    key: ACTIONS.RAISE_CONFIDENCE_FLOOR,

    describe(payload) {
      const { checkKey, suggestedFloor, currentFloor } = payload || {};
      return `${checkKey} will need confidence ${suggestedFloor} before it acts on its own, `
        + `up from ${currentFloor}. Below that it will file the finding and wait for a person `
        + 'instead of repairing.';
    },

    /**
     * @returns {Promise<{before: object, after: object, changed: number}>}
     */
    async apply(payload, deps) {
      const checkKey = String(payload?.checkKey || '');
      const suggested = Number(payload?.suggestedFloor);
      if (!checkKey) throw new Error('The suggestion names no check to change.');
      if (!Number.isInteger(suggested)) throw new Error('The suggestion names no threshold.');

      // BELT AND BRACES WITH THE DATABASE CHECK. The constraint is the real
      // guarantee; this is here so the refusal has a sentence in it rather than
      // a constraint-violation error, and so the rule is visible where the
      // action is read.
      if (suggested < 70 || suggested > 95) {
        throw new Error(`A confidence floor of ${suggested} is outside the 70–95 a check may `
          + 'be tuned to. Wenze only ever proposes MORE caution.');
      }

      const existing = await deps.checkSettings.listCheckSettings(deps.client || null);
      const prior = existing.find((sx) => sx.checkKey === checkKey) || null;

      // Never a step DOWN, even if the evidence changed since the suggestion
      // was raised and somebody has tightened the floor further in the meantime.
      if (prior?.minConfidence != null && Number(prior.minConfidence) >= suggested) {
        return {
          before: { present: true, checkKey, minConfidence: prior.minConfidence },
          after: { minConfidence: prior.minConfidence },
          changed: 0,
          note: `already at ${prior.minConfidence}, which is at least as cautious`,
        };
      }

      // `checkKey` travels IN the before-image, because revert receives only
      // that object and would otherwise have nothing to name.
      const before = prior
        ? { present: true, checkKey, minConfidence: prior.minConfidence ?? null }
        : { present: false, checkKey };

      await deps.checkSettings.setMinConfidence(checkKey, suggested, {
        setBy: deps.actor || 'an administrator',
      }, deps.client || null);

      return { before, after: { checkKey, minConfidence: suggested }, changed: 1 };
    },

    /** Put back exactly what was there — including "nothing", which inherits the global floor. */
    async revert(before, deps) {
      const checkKey = String(before?.checkKey || '');
      if (!checkKey) return { restored: 0 };
      await deps.checkSettings.setMinConfidence(
        checkKey,
        // `present: false` means there was no row, so the floor goes back to
        // NULL and the check inherits the global one again — restoring a
        // default it never had would be inventing a setting.
        before.present ? (before.minConfidence ?? null) : null,
        { setBy: deps.actor || 'an administrator' },
        deps.client || null
      );
      return { restored: 1 };
    },
  },
};

function getLearningAction(key) {
  return REGISTRY[String(key || '')] || null;
}

function listLearningActions() {
  return Object.values(REGISTRY).map((a) => a.key);
}

module.exports = { ACTIONS, REGISTRY, getLearningAction, listLearningActions };
