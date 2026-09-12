/**
 * Saying what Wenze just corrected, in words a dispatcher reads on a phone. PURE.
 *
 * Deliberately NOT the same wording as `admin/src/pages/operations/labels.js`,
 * which names the PROBLEM for someone browsing a list ("Home stay never
 * closed"). A notice arrives after the fact and has to name the FIX, in the past
 * tense, with the subject in front: "Closed a home stay that was left open".
 * Same event, different sentence, so this is a second vocabulary rather than a
 * copy of the first.
 *
 * `undoable` exists because the honest closing line differs. Every correction in
 * the registry is revertible today, but a notice that promises an undo for
 * something that cannot be undone is worse than one that says nothing.
 */

const ACTION_LABELS = Object.freeze({
  'home_time.close_cycle': {
    did: 'Closed a home stay that was left open',
    why: 'the return to the road was already recorded elsewhere',
    undoable: true,
  },
  'home_time.mark_returned_to_road': {
    did: 'Moved a driver back to Road',
    why: 'an active load and the truck\'s own movement both showed they had left',
    undoable: true,
  },
  'home_time.carry_road_clock': {
    did: 'Carried a road clock onto the new chat',
    why: 'the same driver continued on a chat that had restarted their clock',
    undoable: true,
  },
  'home_time.abandon_exhausted_alerts': {
    did: 'Closed off alerts that could never be delivered',
    why: 'they had used every retry; they are recorded, not re-sent',
    undoable: true,
  },
  'identity.sync_profile_status': {
    did: 'Matched a driver profile to what the bot observed',
    why: 'the group and the profile disagreed about whether the driver is active',
    undoable: true,
  },
  'identity.ensure_person': {
    did: 'Gave a driver group its permanent identity',
    why: 'the chat existed with no person behind it, so history could not follow the driver',
    undoable: true,
  },
  'identity.link_telegram': {
    did: 'Matched a Telegram account to a driver',
    why: 'one person in that driver\'s chat, and their name matched the driver',
    undoable: true,
  },
  'identity.set_group_type': {
    did: 'Marked a chat as a company chat rather than a driver\'s',
    why: 'it had no driver placed in it and its name reads as an admin room',
    undoable: true,
  },
  'board.link_person': {
    did: 'Matched a dispatcher board row to a driver',
    why: 'the truck and the name on the board both pointed at the same person',
    undoable: true,
  },
  'identity.sync_unit': {
    did: 'Recorded a driver\'s truck against their permanent identity',
    why: 'the profile named a unit the identity layer did not have',
    undoable: true,
  },
});

/**
 * @returns {{did:string, why:string|null, undoable:boolean}} — never null. An
 *   unlabelled action still produces a readable sentence rather than silence,
 *   because a notice nobody can parse is better than a correction nobody hears
 *   about. `tests/operationsNotices.test.js` fails when a registered action has
 *   no entry here, so the fallback should never be reached in practice.
 */
function describeCorrection(actionKey) {
  const entry = ACTION_LABELS[actionKey];
  if (entry) return entry;
  return { did: `Applied a correction (${actionKey})`, why: null, undoable: true };
}

/** True when the action has a written description rather than the fallback. */
function isLabelledAction(actionKey) {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, actionKey);
}

module.exports = { ACTION_LABELS, describeCorrection, isLabelledAction };
