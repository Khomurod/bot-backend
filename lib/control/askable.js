/**
 * Turning a finding into a question a person can answer in one word. PURE.
 *
 * A THIRD VOCABULARY, ON PURPOSE. `admin/src/pages/operations/labels.js` names
 * the problem for somebody browsing a list; `lib/operations/correctionLabels.js`
 * names the fix after the fact ("Closed a home stay that was left open"). This
 * one asks — present tense, second person, ending in a question mark, because
 * the reader is being asked to decide rather than informed that something
 * happened.
 *
 * WHAT A QUESTION MAY NEVER CONTAIN, and why each is banned:
 *
 *   chat ids, person ids, action keys   they mean nothing to a reader and
 *                                       everything to somebody who should not
 *                                       be able to name an action in a reply.
 *   phone numbers, full addresses       a group chat keeps its history forever.
 *   a model's reasoning                 recorded in the journal; here it is
 *                                       noise that buries the question.
 *
 * A check with no entry here is NOT askable. That is the fail-safe: a new check
 * cannot start asking the fleet's owner questions just because somebody
 * registered an action for it. `tests/controlQuestion.test.js` fails when a
 * `CHECK_TO_ACTION` key has no wording, so the gap is loud rather than silent.
 */

/** What a reply may choose from. Nothing outside this set is ever offered. */
const OFFER_LABELS = Object.freeze({
  approve: 'yes',
  dismiss: 'no (say why)',
  snooze: 'later',
});

/**
 * `ask` is the question. `fact` builds the one or two supporting lines from the
 * finding's own evidence — it must be pure, must tolerate missing evidence, and
 * must never return an id.
 */
const QUESTIONS = Object.freeze({
  'home_time.closable_open_cycle': {
    ask: 'A home stay is still open although the driver is back on the road. Close it?',
    fact: (f) => [f.title].filter(Boolean),
  },
  'identity.status_disagreement': {
    ask: 'A driver\'s profile and their chat disagree about whether they are active. Use what the bot observed?',
    fact: (f) => [f.title].filter(Boolean),
  },
  'home_time.exhausted_internal_alerts': {
    ask: 'Some staff alerts could never be delivered and have used every retry. Close them off?',
    fact: (f) => [f.title].filter(Boolean),
  },
  'identity.group_without_person': {
    ask: 'This driver chat has no permanent identity behind it, so history cannot follow the driver. Create one?',
    fact: (f) => [f.title].filter(Boolean),
  },
  'identity.stale_unit_assignment': {
    ask: 'The profile names a different truck from the one on record. Record the profile\'s truck?',
    fact: (f) => {
      const e = f.evidence || {};
      const from = e.currentUnit || e.from;
      const to = e.targetUnit || e.to;
      return from && to ? [`On record: ${from} · profile says: ${to}`] : [f.title].filter(Boolean);
    },
  },
  'home_time.clock_reset_on_group_change': {
    ask: 'A driver\'s road clock restarted when their chat was recreated. Carry the old clock over?',
    fact: (f) => [f.title].filter(Boolean),
  },
  'identity.telegram_link': {
    ask: 'One person in this driver\'s chat looks like the driver. Record their Telegram account?',
    fact: (f) => {
      const e = f.evidence || {};
      return e.driverName ? [`${e.driverName} — the only person in the chat`] : [f.title].filter(Boolean);
    },
  },
  'identity.telegram_member_unnamed': {
    ask: 'There is one person in this driver\'s chat, but their Telegram name does not look like the driver. Record it as theirs anyway?',
    fact: (f) => {
      const e = f.evidence || {};
      return e.driverName ? [`The driver is ${e.driverName}`] : [f.title].filter(Boolean);
    },
  },
  'identity.non_driver_typed_as_driver': {
    ask: 'This chat is listed as a driver but looks like an office or admin room. Mark it as a company chat?',
    fact: (f) => {
      const e = f.evidence || {};
      return e.groupName
        ? [`${e.groupName} — it would stop getting broadcasts and load documents`]
        : [f.title].filter(Boolean);
    },
  },
  'board.person_link': {
    ask: 'The dispatcher board and Wenze both point at the same driver for this truck. Link them?',
    fact: (f) => {
      const e = f.evidence || {};
      return e.driver && e.truck ? [`${e.driver} · truck ${e.truck}`] : [f.title].filter(Boolean);
    },
  },
  'board.person_link_suggested': {
    ask: 'A dispatcher board row looks like a driver Wenze knows, going on the name alone. Link them?',
    fact: (f) => {
      const e = f.evidence || {};
      return e.driver && e.truck ? [`${e.driver} · truck ${e.truck}`] : [f.title].filter(Boolean);
    },
  },
  'board.truck_disagrees_with_profile': {
    ask: 'The dispatcher board and this driver\'s profile name different trucks. Should I leave it for you to sort out?',
    fact: (f) => {
      const e = f.evidence || {};
      return e.profileUnit && e.boardTruck
        ? [`Profile: ${e.profileUnit} · board: ${e.boardTruck}`]
        : [f.title].filter(Boolean);
    },
  },
  'board.team_person_needs_split': {
    ask: 'Both team drivers on this truck are stored as one person. Should I leave it for now?',
    fact: (f) => [f.title].filter(Boolean),
  },
  'home_time.returned_to_road': {
    ask: 'This driver looks like they are back on the road. Move them to Road?',
    fact: (f) => [f.title].filter(Boolean),
  },
});

function isAskable(checkKey) {
  return Object.prototype.hasOwnProperty.call(QUESTIONS, checkKey);
}

/**
 * Build the question for one finding.
 *
 * @returns {{ask:string, lines:string[]}|null} null when the check has no
 *   wording — which means it is not askable, not that it is broken.
 */
function questionFor(finding) {
  const entry = QUESTIONS[finding?.checkKey];
  if (!entry) return null;
  let lines = [];
  try {
    lines = entry.fact(finding) || [];
  } catch (_) {
    lines = [];
  }
  return { ask: entry.ask, lines: lines.filter(Boolean).slice(0, 2).map(String) };
}

/**
 * What this finding's reply may choose from.
 *
 * `approve` is offered only when there is something to apply. `dismiss` and
 * `snooze` are always available, because "no" and "not now" are answers to any
 * question — and a question a person cannot decline is a demand.
 */
function offeredActionsFor({ hasAction = false } = {}) {
  const keys = hasAction ? ['approve', 'dismiss', 'snooze'] : ['dismiss', 'snooze'];
  return keys.map((key) => ({ key, label: OFFER_LABELS[key] }));
}

/** The one line that tells the reader how to answer. */
function replyHintFor(offered) {
  const parts = (offered || []).map((o) => o.label).filter(Boolean);
  return `Reply to this message: ${parts.join(' · ')}`;
}

module.exports = {
  OFFER_LABELS,
  QUESTIONS,
  isAskable,
  questionFor,
  offeredActionsFor,
  replyHintFor,
};
