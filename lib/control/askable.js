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

/** Who a status question is about, in the words the owner uses. */
function driverLabel(e = {}) {
  const unit = e.unitNumber ? `Unit ${e.unitNumber}` : null;
  if (e.driverName && unit) return `${e.driverName} (${unit})`;
  if (e.driverName) return e.driverName;
  if (unit) return `the driver in ${unit}`;
  if (e.groupName) return `the driver in "${e.groupName}"`;
  return 'this driver';
}

const WORKING_WORD = (active) => (active ? 'working' : 'not working');

/**
 * "Is he working?" answered with the VALUE, not with yes/no about a fix.
 *
 * Production, 2026-10-07: "A driver's profile and their chat disagree about
 * whether they are active. Use what the bot observed?" — asked about a chat the
 * bot had observed nothing in, naming nobody. The owner answered "Driver is
 * active", which no yes/no reader could map. The question now names the driver
 * and the truck, and the buttons ARE the answers: Working / Not working.
 *
 * Whichever value the finding proposes is `approve`; the other is
 * `alternative`. Both are carried out by the same action with the value the
 * owner chose (`services/operations/corrections/statusActions.js`).
 */
const STATUS_QUESTION = {
  ask: (f) => `Is ${driverLabel(f.evidence)} working for us right now?`,
  fact: (f) => {
    const e = f.evidence || {};
    if (e.groupActive == null || !e.profileStatus) return [f.title].filter(Boolean);
    return [`The chat says ${WORKING_WORD(e.groupActive === true)}, the profile says ${WORKING_WORD(e.profileStatus === 'active')}.`];
  },
  choices: (f) => {
    const to = f.proposedChange?.to;
    if (to !== 'active' && to !== 'inactive') return null;
    return [
      {
        key: to === 'active' ? 'approve' : 'alternative', value: 'active',
        label: 'working', button: '✅ Working', vocab: 'working', answers: 'yes',
      },
      {
        key: to === 'inactive' ? 'approve' : 'alternative', value: 'inactive',
        label: 'not working', button: '🚫 Not working', vocab: 'not_working', answers: 'no',
      },
    ];
  },
};

/**
 * `ask` is the question — a string, or a function of the finding when the
 * question names who it is about. `fact` builds the one or two supporting
 * lines from the finding's own evidence — it must be pure, must tolerate
 * missing evidence, and must never return an id. `choices`, when present,
 * replaces yes/no with the answers themselves (see `STATUS_QUESTION`).
 */
const QUESTIONS = Object.freeze({
  'home_time.closable_open_cycle': {
    ask: 'A home stay is still open although the driver is back on the road. Close it?',
    fact: (f) => [f.title].filter(Boolean),
  },
  'identity.status_disagreement': STATUS_QUESTION,
  'identity.status_needs_decision': STATUS_QUESTION,
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
    // THE KEYS ARE THE ONES THE CHECK ACTUALLY WRITES. An earlier version read
    // `currentUnit`/`targetUnit`, which `checks/identityLayer.js` has never
    // emitted, so this silently fell through to the title on every question —
    // working, in the sense that something was printed, and never once running
    // the code it was written to run.
    fact: (f) => {
      const e = f.evidence || {};
      const recorded = e.recordedUnit;
      const profile = e.profileUnit;
      if (!profile) return [f.title].filter(Boolean);
      return [recorded
        ? `On record: ${recorded} · profile says: ${profile}`
        : `No truck on record · profile says: ${profile}`];
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
  'home_time.road_bonus_review': {
    ask: 'This driver was on the road more than six weeks. Was the trip really that long — pay the road bonus?',
    fact: (f) => {
      const e = f.evidence || {};
      const who = [e.driverName, e.unitNumber ? `Unit ${e.unitNumber}` : null].filter(Boolean).join(', ');
      return e.daysOnRoad
        ? [`${who || 'A driver'}: ${e.daysOnRoad} days on the road, $${Number(e.bonusUsd || 0).toFixed(0)} bonus`]
        : [f.title].filter(Boolean);
    },
  },
  'identity.non_driver_typed_as_driver': {
    // ASKED THE WAY ROUND A PERSON CAN ANSWER. "Is it a driver's chat?" — and
    // "Not a driver" takes it off the driver list, which is the fix.
    ask: (f) => (f.evidence?.groupName
      ? `Is "${f.evidence.groupName}" a driver's chat?`
      : 'Is this chat a driver\'s chat?'),
    fact: () => ['If not, I will take it off the driver list — it stops getting driver broadcasts and load documents.'],
    choices: () => [
      {
        key: 'dismiss', label: 'driver\'s chat', button: '🚚 Driver chat',
        vocab: 'driver_chat', answers: 'yes', reason: 'The owner said it is a driver\'s chat.',
      },
      {
        key: 'approve', label: 'not a driver', button: '🏢 Not a driver',
        vocab: 'not_driver_chat', answers: 'no',
      },
    ],
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
 * Turn a decision's reason into something worth reading in a group chat.
 *
 * THE JOURNAL'S REASON IS WRITTEN FOR THE JOURNAL — "confidence 62 below the
 * floor of 75 for identity.sync_unit" is exactly right in a decision row and
 * meaningless in a chat. Two things are wrong with publishing it as-is: it
 * names a check key, which this file's header bans outright, and it asks
 * somebody to care about a number they have never been shown.
 *
 * So the reason is shortened to its shape, and the shapes are a closed list. An
 * unrecognised one produces the plain sentence rather than the raw text.
 */
function heldLineFor(decision) {
  if (!decision) return null;
  const reason = String(decision.reason || '');
  if (decision.verdict === 'unknown') {
    return 'I could not tell on my own — the evidence was missing or out of date.';
  }
  if (/confidence/i.test(reason)) {
    return 'I was not sure enough to do it by myself.';
  }
  if (/source|stale|fresh/i.test(reason)) {
    return 'The only thing pointing that way was out of date, so I left it.';
  }
  return 'I held off doing this by myself.';
}

/**
 * Build the question for one finding.
 *
 * @param {object} finding
 * @param {object} [options]
 * @param {object} [options.heldDecision] the journal row, when Wenze decided
 *   against acting. Its shape becomes ONE line saying why — because "the system
 *   could have done this and chose not to" changes what the owner is being
 *   asked, and without it the question reads as though nothing had happened.
 * @returns {{ask:string, lines:string[]}|null} null when the check has no
 *   wording — which means it is not askable, not that it is broken.
 */
function questionFor(finding, { heldDecision = null } = {}) {
  const entry = QUESTIONS[finding?.checkKey];
  if (!entry) return null;
  let lines = [];
  try {
    lines = entry.fact(finding) || [];
  } catch (_) {
    lines = [];
  }
  const held = heldLineFor(heldDecision);
  // THE HELD LINE GOES FIRST and survives the trim. It is the reason this
  // question exists at all, and a fact line that pushed it off the end would
  // leave the owner reading a question with no explanation of why they are
  // being asked.
  const all = held ? [held, ...lines] : lines;
  let ask = entry.ask;
  let choices = null;
  try {
    if (typeof ask === 'function') ask = ask(finding);
    if (typeof entry.choices === 'function') choices = entry.choices(finding) || null;
  } catch (_) {
    return null;
  }
  if (!ask) return null;
  return {
    ask: String(ask),
    lines: all.filter(Boolean).slice(0, 2).map(String),
    choices: Array.isArray(choices) && choices.length ? choices : null,
  };
}

/**
 * What this finding's reply may choose from.
 *
 * `approve` is offered only when there is something to apply. `dismiss` and
 * `snooze` are always available, because "no" and "not now" are answers to any
 * question — and a question a person cannot decline is a demand.
 */
function offeredActionsFor({ hasAction = false, choices = null } = {}) {
  // A CHOICE QUESTION OFFERS ITS ANSWERS, then "later". No bare "no": to "is
  // he working?" a "no" is the answer "not working", not a refusal.
  if (hasAction && Array.isArray(choices) && choices.length) {
    return [...choices.map((c) => ({ ...c })), { key: 'snooze', label: OFFER_LABELS.snooze }];
  }
  const keys = hasAction ? ['approve', 'dismiss', 'snooze'] : ['dismiss', 'snooze'];
  return keys.map((key) => ({ key, label: OFFER_LABELS[key] }));
}

/**
 * The one line that tells the reader how to answer.
 *
 * THE LABEL IS LOOKED UP WHEN IT IS MISSING. A question stored by an earlier
 * version, or rebuilt from a `question_json` that only kept the keys, would
 * otherwise render "Reply to this message:" with nothing after it — a question
 * with no visible way to answer it, which reads as a bug and gets ignored.
 */
function replyHintFor(offered) {
  const parts = (offered || [])
    .map((o) => (o && (o.label || OFFER_LABELS[o.key])) || null)
    .filter(Boolean);
  // THE BUTTONS COME FIRST because they are what gets used: one tap, where a
  // typed answer is long-press, Reply, type. Typing still works — and is the
  // only way to give a reason with a "no" in one go.
  return `Tap a button below, or reply to this message: ${parts.join(' · ')}`;
}

module.exports = {
  OFFER_LABELS,
  QUESTIONS,
  isAskable,
  driverLabel,
  heldLineFor,
  questionFor,
  offeredActionsFor,
  replyHintFor,
};
