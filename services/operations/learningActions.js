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

      const existing = await deps.checkSettings.listCheckSettings();
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
        });
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
          await deps.checkSettings.deleteCheckSettings(key);
          restored += 1;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await deps.checkSettings.upsertCheckSettings(key, {
          autoApplyEnabled: prior.autoApplyEnabled === true,
          maxAutoPerRun: prior.maxAutoPerRun ?? null,
          updatedBy: deps.actor || 'an administrator',
        });
        restored += 1;
      }
      return { restored };
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
