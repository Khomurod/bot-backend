'use strict';

/**
 * Going back to see whether what we did held.
 *
 * THIS IS WHAT MAKES THE TRACK RECORD REAL. `lib/decisions/sources.js` decides
 * how much a source is worth from how often decisions citing it were later
 * confirmed — and without this pass, nothing is ever confirmed, every source
 * stays unmeasured for ever, and the reliability model is decoration.
 *
 * It grades from the LIVE rows, never from what the decision believed. A
 * decision that graded its own homework would be worth nothing while looking
 * like a track record, which is worse than no track record at all.
 *
 * WHAT IT WILL NOT DO. It does not re-run the check, and it does not form a
 * new opinion about the subject: it asks one narrow question — are the values
 * this correction wrote still there? Anything broader would be a second
 * decision engine, disagreeing with the first at a different hour of the day.
 */
const { compareWritten, shouldRollBack, OUTCOMES } = require('../../lib/decisions/verification');
const decisions = require('../../database/operationalDecisions');

/**
 * How to re-read the subject of each action, and whether it may be undone
 * automatically.
 *
 * `autoRevert` IS FALSE EVERYWHERE, and that is a decision rather than an
 * oversight. Every action in this registry changes operational state about a
 * real driver — a home-time cycle, an employment status, a truck assignment —
 * and an automatic undo of one of those is a second unattended write on top of
 * the first. The machinery is built, tested and ready; what is missing is a
 * case where undoing without asking is clearly safer than telling somebody,
 * and none of these is that case.
 *
 * Turning one on is one word here. It should be a decision somebody makes on
 * purpose, with this comment in front of them.
 */
const SUBJECTS = Object.freeze({
  'home_time.close_cycle': {
    autoRevert: false,
    table: 'driver_road_history',
    async read(client, subjectId) {
      const res = await client.query(
        'SELECT return_to_road_at, home_days FROM driver_road_history WHERE id = $1',
        [Number(subjectId)]
      );
      return res.rows[0] || null;
    },
  },
  'identity.sync_profile_status': {
    autoRevert: false,
    table: 'driver_profiles',
    async read(client, subjectId) {
      const res = await client.query(
        'SELECT status FROM driver_profiles WHERE group_id = $1',
        [Number(subjectId)]
      );
      return res.rows[0] || null;
    },
  },
});

function defaultDeps() {
  return {
    decisions,
    // eslint-disable-next-line global-require
    corrections: require('../operations/corrections/apply'),
  };
}

/**
 * One pass. Returns a summary; never throws.
 *
 * @returns {Promise<{checked:number, confirmed:number, contradicted:number,
 *   expired:number, notChecked:number, rolledBack:number, errors:number}>}
 */
async function runVerificationPass({
  db = null, olderThanMinutes = 60, limit = 100, deps = defaultDeps(),
} = {}) {
  const summary = {
    checked: 0, confirmed: 0, contradicted: 0, expired: 0,
    notChecked: 0, rolledBack: 0, errors: 0,
  };

  let due = [];
  try {
    due = await deps.decisions.listUnverifiedActions({ olderThanMinutes, limit });
  } catch (err) {
    summary.error = err.message;
    return summary;
  }
  if (!due.length) {
    summary.skipped = 'nothing to verify';
    return summary;
  }
  if (!db?.pool) {
    // Honest rather than silent: without a database the pass cannot read the
    // live rows, and grading anything from the decision's own memory is the
    // one thing this module exists to avoid.
    summary.blocked = 'no database';
    return summary;
  }

  const client = await db.pool.connect();
  try {
    for (const decision of due) {
      summary.checked += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const graded = await verifyOne(decision, { client, deps });
        summary[graded.bucket] += 1;
        if (graded.rolledBack) summary.rolledBack += 1;
      } catch (err) {
        summary.errors += 1;
        console.warn(`[VERIFY] ${decision.checkKey}/${decision.subjectId}:`, err.message);
      }
    }
  } finally {
    client.release();
  }
  return summary;
}

const BUCKET = {
  [OUTCOMES.CONFIRMED]: 'confirmed',
  [OUTCOMES.CONTRADICTED]: 'contradicted',
  [OUTCOMES.EXPIRED]: 'expired',
  [OUTCOMES.NOT_CHECKED]: 'notChecked',
};

async function verifyOne(decision, { client, deps }) {
  const subject = SUBJECTS[decision.actionKey];
  if (!subject) {
    await deps.decisions.recordOutcome(
      decision.id, OUTCOMES.NOT_CHECKED,
      `nothing knows how to verify ${decision.actionKey}`
    );
    return { bucket: 'notChecked', rolledBack: false };
  }

  const correction = decision.correctionId
    ? (await client.query(
      'SELECT id, new_values, subject_id, reverted_at FROM operational_corrections WHERE id = $1',
      [decision.correctionId]
    )).rows[0]
    : null;

  if (!correction) {
    await deps.decisions.recordOutcome(
      decision.id, OUTCOMES.NOT_CHECKED,
      'the correction this decision points at is gone'
    );
    return { bucket: 'notChecked', rolledBack: false };
  }

  const current = await subject.read(client, correction.subject_id ?? decision.subjectId);
  const verdict = compareWritten({ wrote: correction.new_values, current });

  const decisionToRoll = shouldRollBack({
    verdict,
    action: subject,
    alreadyReverted: Boolean(correction.reverted_at),
  });

  let rolledBack = false;
  if (decisionToRoll.rollBack) {
    await deps.corrections.revertCorrection({
      correctionId: correction.id,
      admin: null,
      reason: `automatic: ${decisionToRoll.why}`,
    });
    rolledBack = true;
  }

  await deps.decisions.recordOutcome(
    decision.id,
    rolledBack ? OUTCOMES.REVERTED : verdict.outcome,
    rolledBack ? `${verdict.detail}; undone automatically` : verdict.detail
  );
  return { bucket: BUCKET[verdict.outcome] || 'notChecked', rolledBack };
}

module.exports = { runVerificationPass, verifyOne, SUBJECTS };
