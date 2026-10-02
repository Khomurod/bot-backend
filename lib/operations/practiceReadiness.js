/**
 * Has a check practised enough to be worth switching to Autopilot? PURE.
 *
 * WHY. On 2026-10-02 four of twelve checks ran on Autopilot; the other eight
 * reached a verdict of "act" again and again and waited for a person who had
 * answered none of the fifteen questions Wenze asked. The learning pass could
 * not help: it learns from acted decisions and from answers, and there were
 * neither. Yet every one of those waiting decisions IS a rehearsal — Wenze
 * said what it would do and did not do it. This reads those rehearsals.
 *
 * WHAT IT MAY DO: propose, in words, with the evidence. Nothing more.
 *   - `applyAction` is always null. A suggestion never applies itself, and the
 *     learning registry keeps exactly one action, which only switches OFF
 *     (tests/learningActions.test.js). Switching a check ON is a person's act.
 *   - Only checks whose correction is tier `auto` are ever proposed. An
 *     `approval` action is a person's by definition, however good its record.
 *   - A check already on Autopilot is never proposed.
 *
 * WHAT COUNTS AS A GOOD RECORD — every one of these, not a score:
 *   - at least MIN_SUBJECTS different things it would have acted on;
 *   - practised over at least MIN_DAYS, so one busy afternoon is not a record;
 *   - NOT ONE that a person rejected (dismissed the finding);
 *   - it rarely changed its mind: a later "hold"/"unknown" on the same thing
 *     counts against it, and more than MAX_FLIP_RATE of them is too unsteady.
 * How many a person CONFIRMED is reported, never required — on this fleet it
 * is zero, and saying so is the honest part of the proposal.
 */

const PRACTICE = Object.freeze({
  minSubjects: 10,
  minDays: 7,
  maxFlipRate: 0.1,
});

const DAY_MS = 24 * 60 * 60 * 1000;

function toTime(v) {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {Array<{checkKey, subjects, flips, rejected, confirmed, firstAt, lastAt}>} rows
 *   one per check, from database/decisionPractice.js
 * @param {{modes?: Object<string,string>, tiers?: Object<string,string>}} context
 * @returns {Array<object>} the checks ready to propose, with their numbers
 */
function assessPractice(rows, { modes = {}, tiers = {}, options = {} } = {}) {
  const opts = { ...PRACTICE, ...options };
  const out = [];
  for (const row of rows || []) {
    const checkKey = row?.checkKey;
    if (!checkKey) continue;
    if (modes[checkKey] === 'autopilot') continue;
    if (tiers[checkKey] !== 'auto') continue;
    const subjects = Number(row.subjects) || 0;
    const flips = Number(row.flips) || 0;
    const rejected = Number(row.rejected) || 0;
    const confirmed = Number(row.confirmed) || 0;
    const first = toTime(row.firstAt);
    const last = toTime(row.lastAt);
    if (first == null || last == null) continue;
    const days = Math.floor((last - first) / DAY_MS);
    const flipRate = subjects > 0 ? flips / subjects : 1;
    if (subjects < opts.minSubjects) continue;
    if (days < opts.minDays) continue;
    if (rejected > 0) continue;
    if (flipRate > opts.maxFlipRate) continue;
    out.push({ checkKey, subjects, flips, rejected, confirmed, days, mode: modes[checkKey] || 'suggest' });
  }
  return out;
}

/** The words the owner reads. Four facts and one sentence; no ids. */
function describePracticeProposal(p) {
  const what = p.checkKey.replace(/[._]/g, ' ');
  const confirmedLine = p.confirmed > 0
    ? `A person confirmed ${p.confirmed} of them; nobody rejected any.`
    : 'Nobody has confirmed or rejected any of them yet — this record is Wenze\'s own consistency, not a person\'s approval.';
  return {
    kind: 'practice_ready',
    subjectId: p.checkKey,
    title: `"${what}" has practised for ${p.days} days without a single objection`,
    lines: [
      `Would have acted on ${p.subjects} different cases over ${p.days} days, and did not (it is in ${p.mode} mode).`,
      confirmedLine,
      `It changed its mind on ${p.flips} of them.`,
      'Every action it would take can be undone, and each one is checked again afterwards.',
    ],
    suggestion: `Consider switching "${what}" to Autopilot in Operations → Settings. `
      + 'Accepting this records your agreement; the switch itself is yours to make.',
    evidence: {
      subjects: p.subjects, days: p.days, flips: p.flips, rejected: p.rejected,
      confirmed: p.confirmed, mode: p.mode, applicable: false,
    },
    // NO ACTION, ever. Turning automation ON is never Wenze's to apply.
    applyAction: null,
  };
}

function proposePractice(rows, context = {}) {
  return assessPractice(rows, context).map(describePracticeProposal);
}

module.exports = { PRACTICE, assessPractice, describePracticeProposal, proposePractice };
