/**
 * What a load's verdict means for a PERSON — the finding, the notice, and
 * whether it is worth asking at all. PURE: no I/O, no clock of its own.
 *
 * Split out of `services/loads/lifecycleWatch.js`, which owns the pass (what
 * is read, what is written, when). This owns the words, because the words are
 * where the production complaints were: codes shown as "[redacted]", a truck
 * being loaded reported as a disagreement, a driver named by an order id.
 */
const { describeConflict } = require('./lifecycle');

/** The unclear cases a person should see. High confidence files nothing. */
const CHECK_UNCLEAR = 'load.phase_unclear';

/**
 * Who a load is, the way a dispatcher says it: the truck, and the driver's
 * name when the driver's group title carries one. "Unit 310 — JOHN DOE" is
 * something an operator can act on; an order id is something they have to look
 * up first.
 */
function loadWho(state, driverName = null) {
  const base = state.unitNumber
    ? `Unit ${state.unitNumber}`
    : `Load ${state.loadIdentifier || state.orderId}`;
  return driverName ? `${base} — ${driverName}` : base;
}

/**
 * A finding for a load whose phase cannot be settled.
 *
 * There is no `auto` tier here and no registered action, which is what makes
 * "Wenze never guesses a load's status" true by construction rather than by
 * care. The finding says what it saw and what disagreed; a person decides.
 */
function buildFinding(state, verdict, driverName = null) {
  const who = loadWho(state, driverName);
  let why = verdict.conflicts.length
    ? 'the load board and the truck disagree'
    : 'there is not enough evidence to say';
  if (verdict.addressProblem) why = 'the load\'s addresses need checking';
  return {
    checkKey: CHECK_UNCLEAR,
    subjectType: 'load',
    // The order, not the driver: a driver runs many loads and each one is its
    // own question. Keyed on the driver, the second load would update the
    // first's finding instead of becoming a new one.
    subjectId: String(state.orderId),
    title: `${who}: ${why} — ${verdict.summary}`,
    severity: verdict.conflicts.length ? 'warning' : 'info',
    tier: 'warning',
    confidence: verdict.confidence === 'medium' ? 60 : 30,
    evidence: {
      phase: verdict.phase,
      boardStatus: verdict.facts.boardStatus,
      signals: verdict.signals,
      conflicts: verdict.conflicts,
      // The same disagreements in words, so the finding reads like the notice.
      reasons: verdict.conflicts.map(describeConflict),
      addressProblem: verdict.addressProblem || null,
      ...verdict.facts,
    },
    proposedChange: null,
  };
}

/**
 * The notice for one load, or null when nothing should be said.
 *
 * Two different things reach the chat, and they must not read alike:
 *
 *   THE ADDRESSES ARE WRONG. Said ONCE per load — the stops in Datatruck do
 *   not move by themselves, so repeating it every day is noise, and the
 *   finding stays open on the Needs Attention page until they are fixed.
 *
 *   THE BOARD AND THE TRUCK DISAGREE. At most once a day per load, with every
 *   disagreement written as a sentence. The stored codes are never shown: they
 *   are long enough that the composer's credential filter blanked them out,
 *   which is how a notice reached the chat saying only "[redacted]".
 */
function buildNotice(out, driverName = null) {
  const { state, verdict } = out;
  const who = loadWho(state, driverName);
  // The CATEGORY is the caller's: it belongs at the `notify()` call site, where
  // `tests/notificationCoverage.test.js` looks for every category's sender.
  const base = {
    subjectId: String(state.orderId),
    personId: state.personId ?? null,
    groupId: state.groupId ?? null,
  };
  const loadLine = state.loadIdentifier ? `Load ${state.loadIdentifier}` : null;
  if (verdict.addressProblem) {
    return {
      ...base,
      subjectType: 'load_address',
      title: `${who}: the pickup and delivery addresses are the same`,
      lines: [loadLine].filter(Boolean),
      reason: 'Datatruck has the same place for the pickup and the delivery, so Wenze '
        + 'cannot tell where this truck is on the trip',
      action: 'Fix the stops on this load in Datatruck',
      evidence: { addressProblem: verdict.addressProblem },
    };
  }
  if (!verdict.conflicts.length) return null;
  return {
    ...base,
    subjectType: 'load',
    title: `${who}: the load board and the truck disagree`,
    lines: [loadLine, verdict.summary].filter(Boolean),
    reason: verdict.conflicts.map(describeConflict).join('; '),
    action: 'Check which is right — Wenze will not pick a side',
    evidence: {
      phase: verdict.phase,
      boardStatus: verdict.facts.boardStatus,
      conflicts: verdict.conflicts,
    },
  };
}

/** How long a load may sit unreadable before it is a question rather than a Tuesday. */
const STUCK_HOURS = 12;

/**
 * Is this load a QUESTION, or just an ordinary load?
 *
 * The first version filed a finding for every load that was not high
 * confidence, and production showed immediately why that is wrong: 191 of 235
 * loads, which buried the fifteen findings that actually needed somebody.
 *
 * The reason is in this module's own design. `heading_to_pickup` is ALWAYS
 * medium confidence — deliberately, because it is an inference from a truck
 * moving the right way and never an observation — so every load in that phase
 * filed a permanent "there is not enough evidence to say", for the whole trip.
 * That is not a question anybody can answer. It is what the phase means.
 *
 * A load is worth asking about when:
 *
 *   THE SOURCES DISAGREE. The board says delivered and the truck is at the
 *   pickup. Somebody has to reconcile that, and it is exactly the case the
 *   owner asked to be surfaced instead of guessed.
 *
 *   OR IT HAS BEEN UNREADABLE FOR HALF A DAY. A load assigned twenty minutes
 *   ago whose truck has not set off is not a problem; the same load twelve
 *   hours later is either not moving or not being reported, and both are worth
 *   a look.
 *
 * Everything else is ordinary uncertainty about a load that is fine.
 */
function worthAsking(out, nowIso) {
  // A load whose stops are the same place is always worth a look — and only
  // a person in Datatruck can fix it.
  if (out.verdict.addressProblem) return true;
  if (out.verdict.confidence === 'high') return false;
  if (out.verdict.conflicts.length > 0) return true;

  // Unchanged phase plus a stale start is what "stuck" means. A phase that just
  // moved is not stuck however little is known about it.
  if (out.phaseChanged) return false;
  // The REMEMBERED phase start, not the row just written. "How long has this
  // been stuck" is a question about what was already there; reading it off the
  // write couples the answer to whatever the store happens to return.
  const since = Date.parse(out.remembered?.phaseSince || '');
  if (!Number.isFinite(since)) return false;
  return (Date.parse(nowIso) - since) >= STUCK_HOURS * 3600 * 1000;
}

module.exports = {
  CHECK_UNCLEAR, STUCK_HOURS, loadWho, buildFinding, buildNotice, worthAsking,
};
