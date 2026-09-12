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

  // ── the five that had no verifier ─────────────────────────────────────────
  //
  // WHY THAT MATTERED MORE THAN IT LOOKS. `verifyOne` answers `not_checked`
  // for an action with no entry here, and `sourceAgreement` used to count that
  // as a graded-but-unconfirmed outcome — so five unverifiable actions were
  // enough to measure a check's source at 0% agreement and hold every later
  // correction from it for ever. That query now ignores `not_checked`
  // entirely, which stops a missing verifier being read as a failing check;
  // these are the other half of the answer, turning those rows into real
  // judgements instead of silence.
  //
  // EVERY `read` MUST RETURN AT LEAST ONE KEY THAT `new_values` ALSO HAS.
  // `compareWritten` skips a field the row does not carry, so a verifier that
  // selected the wrong columns would find nothing to disagree with and report
  // CONFIRMED for everything — a false clean bill of health, which is worse
  // than the `not_checked` it replaced. The tests assert the overlap.

  'identity.ensure_person': {
    autoRevert: false,
    table: 'driver_person_groups',
    async read(client, subjectId) {
      const res = await client.query(
        `SELECT person_id AS "personId" FROM driver_person_groups
          WHERE group_id = $1 AND ended_at IS NULL`,
        [Number(subjectId)]
      );
      return res.rows[0] || null;
    },
  },

  'identity.sync_unit': {
    autoRevert: false,
    table: 'driver_units',
    async read(client, subjectId) {
      const res = await client.query(
        `SELECT u.unit_number AS "unitNumber", u.person_id AS "personId"
           FROM driver_units u
           JOIN driver_person_groups g
             ON g.person_id = u.person_id AND g.ended_at IS NULL
          WHERE g.group_id = $1 AND u.ended_at IS NULL`,
        [Number(subjectId)]
      );
      return res.rows[0] || null;
    },
  },

  'identity.set_group_type': {
    autoRevert: false,
    table: 'groups',
    async read(client, subjectId) {
      const res = await client.query(
        'SELECT group_type AS "groupType" FROM groups WHERE id = $1',
        [Number(subjectId)]
      );
      return res.rows[0] || null;
    },
  },

  // The subject is the board row's KEY, not an integer id — `board_row` is the
  // one subject type in this table that is not numeric, and `Number(subjectId)`
  // on it would read NaN and find nothing.
  'board.link_person': {
    autoRevert: false,
    table: 'dispatch_board_rows',
    async read(client, subjectId) {
      const res = await client.query(
        `SELECT person_id AS "personId", link_source AS "linkSource"
           FROM dispatch_board_rows WHERE row_key = $1`,
        [String(subjectId)]
      );
      return res.rows[0] || null;
    },
  },

  'home_time.mark_returned_to_road': {
    autoRevert: false,
    table: 'driver_home_status',
    async read(client, subjectId) {
      const res = await client.query(
        'SELECT state, state_since FROM driver_home_status WHERE group_id = $1',
        [Number(subjectId)]
      );
      return res.rows[0] || null;
    },
  },

  'home_time.abandon_exhausted_alerts': {
    autoRevert: false,
    table: 'home_time_requests',
    /**
     * THE ONE THAT NEEDS THE CORRECTION. Its subject is the outbox as a whole;
     * the rows it changed are named only in `new_values.requestIds`.
     *
     * "Still abandoned" is a property of ALL of them, so the read reports the
     * state only when every row agrees — one row quietly restored is the
     * contradiction worth catching, and reporting the majority would hide it.
     */
    async read(client, subjectId, correction) {
      const ids = (correction?.new_values?.requestIds || []).map(Number).filter(Number.isInteger);
      if (!ids.length) return null;
      // `internal_alert_state`, WHICH IS THE COLUMN THAT EXISTS. The action
      // writes that column and records it in `new_values` under the logical
      // key `state`, so the read has to translate — exactly as its own revert
      // does. Querying `state` here would have thrown on every run, been
      // swallowed per-decision, and left the verifier silently useless: the
      // same shape as `readRetention` asking for columns that were not there.
      // A stubbed client cannot catch that, so the test for this is a Pg one.
      const res = await client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE internal_alert_state = 'abandoned')::int AS abandoned
           FROM home_time_requests WHERE id = ANY($1::int[])`,
        [ids]
      );
      const row = res.rows[0];
      if (!row || !row.total) return null;
      return {
        state: row.abandoned === row.total ? 'abandoned' : 'partly_restored',
        requestIds: ids,
      };
    },
  },

  // `home_time.carry_road_clock` DELIBERATELY HAS NO ENTRY. Its finding
  // (`home_time.clock_reset_on_group_change`) is filed at tier `approval`, so
  // it never enters the auto-correction plan and never reaches the decision
  // journal — there is no outcome for a verifier to set. If it is ever
  // promoted to `auto`, it needs one here before that switch is flipped.
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

  // The correction is passed as well as the subject id. Some actions write
  // rows the subject id cannot reach — the abandoned-alert batch names its
  // request ids in `new_values` and nowhere else — and a verifier that cannot
  // find what it wrote can only answer `not_checked`.
  const current = await subject.read(
    client, correction.subject_id ?? decision.subjectId, correction
  );
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
