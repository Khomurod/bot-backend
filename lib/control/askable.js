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

const { QUESTIONS, driverLabel } = require('./questionWording');

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
  const lines = safeLines(entry.fact, finding);
  const held = heldLineFor(heldDecision);
  // THE HELD LINE GOES FIRST, and the facts still get their two lines after
  // it. It is the reason this question exists at all; the facts are what make
  // it answerable (owner, 5 November 2026: a question without the names in it
  // cannot be answered), so neither is trimmed to make room for the other.
  const all = held ? [held, ...lines.slice(0, 2)] : lines.slice(0, 2);
  let ask = entry.ask;
  let choices = null;
  let yes = null;
  try {
    if (typeof ask === 'function') ask = ask(finding);
    if (typeof entry.choices === 'function') choices = entry.choices(finding) || null;
    if (typeof entry.yes === 'function') yes = entry.yes(finding) || null;
  } catch (_) {
    return null;
  }
  if (!ask) return null;
  return {
    ask: String(ask),
    lines: all.map(String),
    yes: yes ? String(yes) : null,
    choices: Array.isArray(choices) && choices.length ? choices : null,
  };
}

/** A builder's lines, without the empties, and never a throw. */
function safeLines(builder, finding) {
  if (typeof builder !== 'function') return [];
  try {
    return (builder(finding) || []).filter(Boolean).map(String);
  } catch (_) {
    return [];
  }
}

/**
 * What Wenze says when the owner asks back — "who is it?", "tell me the name".
 *
 * EVERYTHING THE QUESTION KNOWS, and nothing it does not: the question's own
 * facts untrimmed, the entry's extra details, and what Yes will do. Read only
 * from the finding's stored evidence — no lookup, no model — so the answer is
 * exactly what the question was based on, and the same rules about ids and
 * phone numbers hold.
 *
 * @returns {string[]|null} null when the check is not askable.
 */
function detailsFor(finding) {
  const entry = QUESTIONS[finding?.checkKey];
  if (!entry) return null;
  const q = questionFor(finding);
  if (!q) return null;
  return [
    ...safeLines(entry.fact, finding),
    ...safeLines(entry.details, finding),
    q.yes,
  ].filter(Boolean);
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
  detailsFor,
  offeredActionsFor,
  replyHintFor,
};
