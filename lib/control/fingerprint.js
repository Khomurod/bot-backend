/**
 * What a remembered answer is actually AN ANSWER TO. PURE.
 *
 * THE PROBLEM THIS SOLVES. B1 made a finding answerable. It did not make the
 * answer last. The sweep re-derives the same condition on the next pass, files
 * the finding again with a NEW id, and asks again — so the owner answers the
 * same question every week, and the channel becomes the thing they mute.
 *
 * THE TRAP ON THE OTHER SIDE. The obvious fix — remember the answer against the
 * driver, or against the check — silences a check for that subject FOR EVER.
 * "He is a team driver, that is why the truck looks shared" is a true answer
 * about ONE situation. Six weeks later he is alone in a different truck and the
 * same shared-truck finding is a real problem that nobody is ever told about,
 * because a memory keyed on him alone still matches.
 *
 * SO A MEMORY IS BOUND TO THE CONDITION. `fingerprintFor` hashes only the
 * evidence fields that DEFINE the situation the owner was looking at. Change
 * the truck, the other holder, the status, the direction of the disagreement —
 * the fingerprint changes, the memory does not match, and Wenze asks again.
 * Change nothing but the finding's id, the timestamps, or the wording of its
 * title, and the memory holds.
 *
 * WHICH FIELDS, AND WHY IT IS A CLOSED LIST. `CONDITION_FIELDS` names them per
 * check. Hashing the whole evidence object would be easier and would be wrong
 * twice over: it carries `lastSeenAt`, counts and other fields that move on
 * every sweep (so no memory would ever match, and the feature would silently do
 * nothing), and it carries display names that can be edited (so renaming a chat
 * would re-ask a settled question). A check absent from the list is NOT
 * rememberable — that is the fail-safe. A new check starts by asking every
 * time, which is noisy and honest, rather than by silencing itself on a
 * fingerprint nobody chose.
 */

const { createHash } = require('crypto');

/**
 * The evidence fields that define each condition.
 *
 * Read each line as: "if any of these changes, this is a different situation
 * and the owner has not answered it."
 */
const CONDITION_FIELDS = Object.freeze({
  // WHICH cycle can be closed and from WHAT evidence. A different return
  // timestamp is a different repair.
  'home_time.closable_open_cycle': ['evidenceClass', 'observedReturnAt'],

  // The direction of the disagreement and who observed it. Flip either and the
  // answer "use what the bot observed" no longer means the same thing.
  'identity.status_disagreement': ['groupActive', 'profileStatus', 'statusSource'],

  // A different pile of undelivered alerts is a different pile.
  'home_time.exhausted_internal_alerts': ['count', 'requestIds'],

  // The chat itself. `groupName` is deliberately absent: a renamed chat is the
  // same chat with the same missing identity.
  'identity.group_without_person': ['groupId'],

  // Which truck is being moved from and to.
  'identity.stale_unit_assignment': ['profileUnit', 'recordedUnit'],

  // Which two chats, and the clock that was lost.
  'home_time.clock_reset_on_group_change': ['fromGroupId', 'toGroupId', 'fromStateSince', 'toStateSince'],

  // WHICH account is being proposed, and whether it was the only candidate. A
  // second person joining the chat changes the question completely.
  'identity.telegram_link': ['personId', 'candidates'],
  'identity.telegram_member_unnamed': ['personId', 'candidates'],

  // What the chat is. `groupType` moves the moment the answer is applied.
  'identity.non_driver_typed_as_driver': ['groupId', 'groupType'],

  // Which board row, which truck, and which person it would be attached to.
  'board.person_link': ['rowKey', 'truck', 'fleetType', 'linkedPersonId', 'recordedPersonId'],
  'board.person_link_suggested': ['rowKey', 'truck', 'fleetType', 'linkedPersonId', 'recordedPersonId'],

  // The two trucks that disagree. A NEW disagreement about the same driver is
  // a new question — which is exactly what a memory must not swallow.
  'board.truck_disagrees_with_profile': ['profileUnit', 'boardTruck'],

  // Which row, and which person the pair collapsed onto.
  'board.team_person_needs_split': ['rowKey', 'truck', 'linkedPersonId'],

  // WHEN the driver went home, and what suggested they are back. A new set of
  // signals is a new claim about them.
  'home_time.returned_to_road': ['homeSince', 'signals'],
});

/** Can an answer to this check be remembered at all? */
function isRememberable(checkKey) {
  return Object.prototype.hasOwnProperty.call(CONDITION_FIELDS, checkKey);
}

/**
 * One evidence value as a stable string.
 *
 * Numbers arrive as numbers from the checks and as strings from Postgres —
 * `12` and `'12'` are the same truck, and a fingerprint that disagreed with
 * itself across that boundary would re-ask every question once per restart.
 * Arrays keep their order, because the order of `requestIds` and of `signals`
 * is produced deterministically by the checks and a re-order there is a real
 * change. Objects are serialised with their keys sorted, because `JSON.stringify`
 * key order follows insertion and two equal objects could hash differently.
 */
function stable(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // A numeric string normalises to its number so `'12'`, `12` and `' 12 '`
    // agree. `'007'` does NOT — leading zeros are part of a unit number, and
    // `Number('007')` would make unit 007 and unit 7 the same condition.
    if (/^-?\d+$/.test(trimmed) && !/^-?0\d/.test(trimmed)) return String(Number(trimmed));
    return trimmed;
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${k}:${stable(value[k])}`).join(',')}}`;
  }
  return String(value);
}

/**
 * The fingerprint of the condition this finding describes.
 *
 * @returns {string|null} null when the check is not rememberable — which means
 *   "ask again next time", not "something went wrong".
 */
function fingerprintFor(finding) {
  const checkKey = finding?.checkKey;
  if (!checkKey || !isRememberable(checkKey)) return null;
  const evidence = finding.evidence || {};
  const parts = CONDITION_FIELDS[checkKey]
    .map((field) => `${field}=${stable(evidence[field])}`);
  return createHash('sha256')
    .update(`${checkKey}\n${parts.join('\n')}`)
    .digest('hex')
    .slice(0, 32);
}

function sameSubject(finding, memory) {
  return String(finding?.checkKey || '') === String(memory?.checkKey || '')
    && String(finding?.subjectType || '') === String(memory?.subjectType || '')
    && String(finding?.subjectId ?? '') === String(memory?.subjectId ?? '');
}

/**
 * Does this remembered answer apply to this finding, right now?
 *
 * BOTH halves are required. The subject alone would silence a new problem about
 * the same driver; the fingerprint alone would let one driver's answer settle
 * an identical-looking condition on somebody else.
 *
 * @param {object} finding      the finding the sweep just filed
 * @param {object} memory       a `control_knowledge` row, camel-cased
 * @param {Date}   now
 */
function memoryApplies(finding, memory, now = new Date()) {
  if (!finding || !memory) return false;
  if (memory.revokedAt) return false;
  if (memory.expiresAt && new Date(memory.expiresAt).getTime() <= now.getTime()) return false;
  if (!sameSubject(finding, memory)) return false;
  const fingerprint = fingerprintFor(finding);
  if (!fingerprint) return false;
  return fingerprint === memory.evidenceFingerprint;
}

/**
 * What a remembered answer is allowed to DO by itself. Exactly one thing.
 *
 * A REMEMBERED `approve` IS NEVER RE-APPLIED. The owner approved ONE case, not
 * a standing permission — standing permissions live in
 * `operational_check_settings.mode`, where they are visible on a screen and can
 * be switched off. Applying one automatically would be autopilot through a side
 * door, entered by answering "yes" in a chat. It is still recorded, because
 * "you have said yes to this before" is worth showing a person and is the input
 * B3's learning pass reads.
 *
 * A remembered `snooze` is not acted on either, for a different reason: "later"
 * is a delay, not an answer. Re-applying it would turn one "not now" into a
 * question that is postponed for ever, which is the failure this whole table is
 * supposed to prevent rather than automate.
 */
const ACTS_FROM_MEMORY = Object.freeze(['dismiss']);

function actsFromMemory(answerAction) {
  return ACTS_FROM_MEMORY.includes(String(answerAction || ''));
}

module.exports = {
  CONDITION_FIELDS,
  ACTS_FROM_MEMORY,
  isRememberable,
  stable,
  fingerprintFor,
  memoryApplies,
  actsFromMemory,
};
