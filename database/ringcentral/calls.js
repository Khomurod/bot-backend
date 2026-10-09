/**
 * Raw recruiter CALL RECORDS — database helpers.
 *
 * Every polled call is stored so KPIs stay recomputable; the upsert is keyed on
 * the RingCentral record id, so re-polling an overlapping window is idempotent.
 *
 * WRITES THAT WOULD CHANGE NOTHING ARE NOT SENT (October 2026, when the hosted
 * database's monthly transfer allowance was nearly spent). The sync re-reads
 * every call since midnight on each 10-minute pass, so the same unchanged call
 * used to be upserted ~144 times a day — about 33,000 statements. This module
 * remembers what it last wrote for each call id (the exact values sent), and a
 * call is written again only when:
 *   - any value differs — a duration or result that finalized, a re-attributed
 *     recruiter — so a changed call is written on the very next pass;
 *   - or CALL_REWRITE_AFTER_MS has passed, the safety net for a write this
 *     process did not make (another instance during a deploy writing an older
 *     reading of the same call).
 * A write that FAILS forgets the call entirely, so the next pass sends it
 * whatever it last knew — a failure is never remembered as written.
 *
 * Every write that is sent drops the cached public leaderboard
 * (./leaderboardCache.js), which is why a pass that changed nothing leaves the
 * board alone.
 *
 * The memory is owned here. Bounded: entries past the rewrite window are
 * dropped once MAX_REMEMBERED_CALLS is reached; a day is a few hundred calls.
 *
 * Split out of database/ringcentral.js, which re-exports every symbol here.
 */
const { query } = require('../pool');
const { invalidateLeaderboardCache } = require('./leaderboardCache');

const CALL_REWRITE_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_REMEMBERED_CALLS = 2000;

/** call id → { signature, at }: what this process last wrote, and when. */
const lastWritten = new Map();

function rememberWrite(id, signature, now) {
  if (!lastWritten.has(id) && lastWritten.size >= MAX_REMEMBERED_CALLS) {
    for (const [key, entry] of lastWritten) {
      if (now - entry.at >= CALL_REWRITE_AFTER_MS) lastWritten.delete(key);
    }
    if (lastWritten.size >= MAX_REMEMBERED_CALLS) lastWritten.clear();
  }
  lastWritten.set(id, { signature, at: now });
}

// ─── Calls ───

/**
 * Upsert one call record; duration/result may finalize on a later poll.
 *
 * @returns {Promise<boolean>} true when the statement was sent, false when
 *   this process already wrote exactly these values within the rewrite window.
 */
async function upsertCall(call) {
  const params = [
    String(call.id), call.sessionId || null, call.recruiterId || null,
    call.recruiterNumberNormalized || null, call.direction || null, call.result || null,
    call.fromNumber || null, call.toNumber || null,
    Number.isFinite(call.durationSeconds) ? call.durationSeconds : 0,
    call.callTime,
  ];
  const id = params[0];
  const signature = JSON.stringify(params);
  const now = Date.now();
  const previous = lastWritten.get(id);
  if (previous && previous.signature === signature && now - previous.at < CALL_REWRITE_AFTER_MS) return false;

  try {
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
      params
    );
  } catch (err) {
    lastWritten.delete(id);
    // Whether a failed statement reached the table cannot be known from here.
    invalidateLeaderboardCache();
    throw err;
  }
  rememberWrite(id, signature, now);
  invalidateLeaderboardCache();
  return true;
}

module.exports = {
  CALL_REWRITE_AFTER_MS,
  upsertCall,
};
