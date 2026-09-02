/**
 * Raw recruiter CALL RECORDS — database helpers.
 *
 * Every polled call is stored so KPIs stay recomputable; the upsert is keyed on
 * the RingCentral record id, so re-polling an overlapping window is idempotent.
 *
 * Split out of database/ringcentral.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

// ─── Calls ───

/** Upsert one call record; duration/result may finalize on a later poll. */
async function upsertCall(call) {
  await query(
    `INSERT INTO ringcentral_calls
       (id, session_id, recruiter_id, recruiter_number_normalized, direction, result,
        from_number, to_number, duration_seconds, call_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       session_id = EXCLUDED.session_id,
       recruiter_id = EXCLUDED.recruiter_id,
       recruiter_number_normalized = EXCLUDED.recruiter_number_normalized,
       direction = EXCLUDED.direction,
       result = EXCLUDED.result,
       from_number = EXCLUDED.from_number,
       to_number = EXCLUDED.to_number,
       duration_seconds = EXCLUDED.duration_seconds,
       call_time = EXCLUDED.call_time`,
    [
      String(call.id), call.sessionId || null, call.recruiterId || null,
      call.recruiterNumberNormalized || null, call.direction || null, call.result || null,
      call.fromNumber || null, call.toNumber || null,
      Number.isFinite(call.durationSeconds) ? call.durationSeconds : 0,
      call.callTime,
    ]
  );
}

module.exports = {
  upsertCall,
};
