/**
 * What each question SAYS. PURE. The builder is `./askable.js`.
 *
 * A QUESTION A PERSON CAN ANSWER WITHOUT OPENING ANYTHING. The owner's
 * complaint of 5 November 2026: "There is one person in this driver's chat, but
 * their Telegram name does not look like the driver. Record it as theirs
 * anyway?" — asked without the Telegram name, so the only possible answer was
 * "tell me the name first". The name was in the finding all along. So every
 * entry here now says three things:
 *
 *   WHO     the driver or the chat, by name — never "this driver";
 *   WHAT    both sides of what disagrees: the profile's value AND the record's,
 *           the Telegram name AND the driver's name, the day it started;
 *   YES     what pressing Yes will do, in one line starting "Yes →".
 *
 * `tests/controlQuestionPrecise.test.js` holds a realistic finding for every
 * askable check and fails when a question stops naming its subject or its
 * values, leaks an id, or has no "Yes →" line — so a vague question cannot be
 * written again without a red test.
 *
 * `details` adds what did not fit: it is what Wenze replies when the owner asks
 * back ("who is it?", "tell me the name"), read only from the stored evidence.
 *
 * WHAT A QUESTION MAY NEVER CONTAIN is in `./askable.js`'s header: ids, action
 * keys, phone numbers, full addresses, a model's reasoning.
 */

const FLEET_WORD = Object.freeze({
  company: 'Company driver',
  owner_operator: 'Owner-operator',
  lease: 'Lease driver',
  unknown: 'not set',
});

const fleetWord = (f) => FLEET_WORD[f] || FLEET_WORD.unknown;
/** A truck in words: its fleet, and its owner when it is an owner's truck ("Owner-operator truck of ROGER"). */
const truckWord = (fleet, owner) => (owner ? `${fleetWord(fleet)} truck of ${owner}` : fleetWord(fleet));
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const clip = (text, n) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

/** Who a question is about, in the words the owner uses. */
function driverLabel(e = {}) {
  const unit = e.unitNumber ? `Unit ${e.unitNumber}` : null;
  if (e.driverName && unit) return `${e.driverName} (${unit})`;
  if (e.driverName) return e.driverName;
  if (e.groupName) return `the driver in "${e.groupName}"`;
  if (unit) return `the driver in ${unit}`;
  return 'this driver';
}

const chatName = (e = {}) => (e.groupName ? `"${e.groupName}"` : 'this driver\'s chat');

/** A Telegram account as a person sees it: name and @username — never the numeric id. */
function telegramName(c = {}) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  const handle = c.username ? `@${String(c.username).replace(/^@/, '')}` : null;
  if (name && handle) return `"${name}" (${handle})`;
  if (name) return `"${name}" (no @username)`;
  if (handle) return handle;
  return 'an account with no name and no @username';
}

const onlyCandidate = (e = {}) => (Array.isArray(e.candidates) && e.candidates.length === 1 ? e.candidates[0] : null);

const WORKING_WORD = (active) => (active ? 'working' : 'not working');

/**
 * "Is he working?" answered with the VALUE, not with yes/no about a fix.
 *
 * Production, 2026-10-07: asked about a chat the bot had observed nothing in,
 * naming nobody; the owner answered "Driver is active", which no yes/no reader
 * could map. The question names the driver and the truck, and the buttons ARE
 * the answers: Working / Not working.
 */
const STATUS_QUESTION = {
  ask: (f) => `Is ${driverLabel(f.evidence)} working for us right now?`,
  fact: (f) => {
    const e = f.evidence || {};
    if (e.groupActive == null || !e.profileStatus) return [f.title].filter(Boolean);
    return [
      `The chat says ${WORKING_WORD(e.groupActive === true)}, the profile says ${WORKING_WORD(e.profileStatus === 'active')}.`,
      e.groupName ? `Chat "${e.groupName}"` : null,
    ];
  },
  yes: () => 'Working → the profile is set to active · Not working → the profile is set to inactive.',
  details: (f) => {
    const e = f.evidence || {};
    return [e.statusUpdatedAt ? `The chat's status last changed ${day(e.statusUpdatedAt)}.` : null];
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

/** The two Telegram questions share their facts; only the doubt differs. */
function telegramQuestion({ doubt }) {
  return {
    ask: (f) => {
      const e = f.evidence || {};
      const c = onlyCandidate(e);
      return c && e.driverName
        ? `Is ${telegramName(c)} ${e.driverName}'s own Telegram account?`
        : `Is the one person in ${chatName(e)} the driver?`;
    },
    fact: (f) => {
      const e = f.evidence || {};
      const c = onlyCandidate(e);
      return [
        c ? `Chat ${chatName(e)} · the only person in it: ${telegramName(c)}` : f.title,
        doubt && e.driverName ? `Their Telegram name does not look like ${e.driverName}.` : null,
      ];
    },
    yes: (f) => {
      const e = f.evidence || {};
      const c = onlyCandidate(e);
      return c && e.driverName ? `Yes → I record ${telegramName(c)} as ${e.driverName}'s account.` : null;
    },
  };
}

const QUESTIONS = Object.freeze({
  'home_time.closable_open_cycle': {
    ask: (f) => `Close ${driverLabel(f.evidence)}'s home stay that started ${day(f.evidence?.homeArrivedAt) || 'earlier'}?`,
    fact: (f) => {
      const e = f.evidence || {};
      return e.homeArrivedAt && e.observedReturnAt
        ? [`Home since ${day(e.homeArrivedAt)} · back on the road ${day(e.observedReturnAt)} (already recorded)`]
        : [f.title];
    },
    yes: (f) => {
      const days = f.evidence?.homeDays;
      return `Yes → I close the stay${days != null ? ` as ${days} day(s) at home` : ''}, from the dates already recorded.`;
    },
  },
  'identity.status_disagreement': STATUS_QUESTION,
  'identity.status_needs_decision': STATUS_QUESTION,
  'home_time.exhausted_internal_alerts': {
    ask: (f) => `${f.evidence?.count || 'Some'} staff home-time alert(s) failed every retry. Stop retrying them?`,
    fact: (f) => {
      const e = f.evidence || {};
      return [[
        e.oldestAt ? `Oldest from ${day(e.oldestAt)}` : null,
        e.lastError ? `last error: ${clip(e.lastError, 80)}` : null,
      ].filter(Boolean).join(' · ') || f.title];
    },
    yes: () => 'Yes → they are marked abandoned and not retried. Nothing is sent to anyone.',
  },
  'identity.group_without_person': {
    ask: (f) => `Give chat ${chatName(f.evidence)} a permanent driver record?`,
    fact: () => ['Without one, this driver\'s history is lost if the chat is ever recreated.'],
    yes: () => 'Yes → I link the chat to the driver with the same Telegram account or name, or create a new driver record.',
  },
  'identity.stale_unit_assignment': {
    ask: (f) => `Record unit ${f.evidence?.profileUnit} as the truck of ${chatName(f.evidence)}?`,
    fact: (f) => {
      const e = f.evidence || {};
      if (!e.profileUnit) return [f.title];
      return [`Profile says unit ${e.profileUnit} · the driver's record says ${e.recordedUnit || 'no truck'}`];
    },
    yes: (f) => {
      const e = f.evidence || {};
      return `Yes → the driver is recorded in unit ${e.profileUnit}${e.recordedUnit ? ` instead of ${e.recordedUnit}` : ''}.`;
    },
  },
  'identity.unit_handover': {
    ask: (f) => `Hand unit ${f.evidence?.unitNumber} to the driver of ${chatName(f.evidence)}?`,
    fact: (f) => {
      const e = f.evidence || {};
      const from = (e.holders || []).map((h) => h.displayName).filter(Boolean).join(', ');
      return e.unitNumber && from
        ? [`Unit ${e.unitNumber} is still recorded to ${from}, who has no active chat.`]
        : [f.title];
    },
    yes: (f) => {
      const e = f.evidence || {};
      const from = (e.holders || []).map((h) => h.displayName).filter(Boolean).join(', ');
      return `Yes → unit ${e.unitNumber} moves to the driver of ${chatName(e)}${from ? `; ${from}'s record of it is closed` : ''}.`;
    },
  },
  'identity.unit_fleet_behind_profile': {
    ask: (f) => `Record unit ${f.evidence?.unitNumber} of ${chatName(f.evidence)} as ${truckWord(f.evidence?.profileFleet, f.evidence?.profileOwner)}?`,
    fact: (f) => {
      const e = f.evidence || {};
      return e.unitNumber && e.profileFleet
        ? [`Profile says ${truckWord(e.profileFleet, e.profileOwner)} · truck record says ${truckWord(e.recordedFleet, e.recordedOwner)}`]
        : [f.title];
    },
    yes: (f) => `Yes → the truck record changes to ${truckWord(f.evidence?.profileFleet, f.evidence?.profileOwner)}; the old record is kept in history.`,
  },
  'identity.truck_from_board': {
    ask: (f) => `Is ${f.evidence?.boardDriver || 'the driver'} of ${chatName(f.evidence)} in truck ${f.evidence?.boardTruck}, as the board says?`,
    fact: (f) => {
      const e = f.evidence || {};
      return e.boardTruck
        ? [`Board: ${e.boardTruck} — ${truckWord(e.boardFleet, e.boardOwner)} · profile: ${truckWord(e.profileFleet, e.profileOwner)}`]
        : [f.title];
    },
    yes: (f) => `Yes → the profile records ${truckWord(f.evidence?.boardFleet, f.evidence?.boardOwner)}; the driver's own type stays as it is.`,
  },
  'home_time.clock_reset_on_group_change': {
    ask: (f) => `Carry ${f.evidence?.displayName || 'this driver'}'s road clock over from the old chat?`,
    fact: (f) => {
      const e = f.evidence || {};
      if (!e.fromStateSince || !e.toStateSince) return [f.title];
      return [
        `Old chat ${e.fromGroupName ? `"${e.fromGroupName}"` : ''}: on the road since ${day(e.fromStateSince)}`.replace(/\s+:/, ':'),
        `New chat ${e.toGroupName ? `"${e.toGroupName}"` : ''}: clock restarted ${day(e.toStateSince)}${e.lostDays ? ` (${e.lostDays} days lost)` : ''}`.replace(/\s+:/, ':'),
      ];
    },
    yes: (f) => {
      const e = f.evidence || {};
      return `Yes → the new chat's road clock starts ${day(e.fromStateSince) || 'from the old date'} again, so the road bonus counts those days.`;
    },
  },
  'identity.telegram_link': telegramQuestion({ doubt: false }),
  'identity.telegram_member_unnamed': telegramQuestion({ doubt: true }),
  'home_time.road_bonus_review': {
    ask: (f) => {
      const e = f.evidence || {};
      return `Pay ${driverLabel(e)} the $${Number(e.bonusUsd || 0).toFixed(0)} road bonus for ${e.daysOnRoad || '?'} days on the road?`;
    },
    fact: (f) => {
      const e = f.evidence || {};
      // The question already names the days and the amount; the dates are the
      // only thing to add, and a repeat of the title would add nothing.
      return e.roadStartedAt
        ? [`On the road ${day(e.roadStartedAt)} → ${day(e.homeArrivedAt) || 'now'} (${e.daysOnRoad} days)`]
        : [];
    },
    yes: () => 'Yes → the bonus summary is posted to the road-bonus group · No → nothing is paid.',
  },
  'identity.non_driver_typed_as_driver': {
    // ASKED THE WAY ROUND A PERSON CAN ANSWER. "Is it a driver's chat?" — and
    // "Not a driver" takes it off the driver list, which is the fix.
    ask: (f) => (f.evidence?.groupName
      ? `Is "${f.evidence.groupName}" a driver's chat?`
      : 'Is this chat a driver\'s chat?'),
    fact: () => [],
    yes: () => 'Not a driver → I take it off the driver list: no more driver broadcasts or load documents there.',
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
  'home_time.returned_to_road': {
    ask: (f) => `Move ${driverLabel(f.evidence)} to Road?`,
    fact: (f) => {
      const e = f.evidence || {};
      return [
        e.homeSince ? `Home since ${day(e.homeSince)}` : null,
        e.summary ? `Why I think so: ${clip(e.summary, 160)}` : f.title,
      ];
    },
    yes: (f) => {
      const at = day(f.proposedChange?.returnToRoadAt);
      return `Yes → marked back on the road${at ? ` from ${at}` : ''}; the home stay closes and the road clock starts.`;
    },
  },
});

module.exports = {
  QUESTIONS, FLEET_WORD, driverLabel, telegramName, day,
};
