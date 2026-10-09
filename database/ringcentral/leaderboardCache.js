'use strict';

/**
 * The public recruiter leaderboard's computed answer, kept in this process.
 *
 * WHY. `/recruiters` is open all day on an office screen and polls every 60
 * seconds in the "today" view. Each poll used to cost the hosted database the
 * settings row plus one row per call made today — about 14 MB a day per open
 * screen in October 2026, when the monthly transfer allowance was nearly spent.
 * What the board shows can only change when a call is written (the RingCentral
 * sync, every 10 minutes), when an admin changes a recruiter or the KPI
 * settings, or when the day rolls over — so it is answered from here between
 * those moments.
 *
 * THE RULE THAT KEEPS IT TRUE. Every write that can change the board calls
 * `invalidateLeaderboardCache()`, from the module that makes it:
 *   - ./calls.js — every call the sync writes (so a pass that changed something
 *     is on the board at the next poll, and a pass that changed nothing leaves
 *     the board alone);
 *   - ./recruiters.js — create, update and delete (who is listed, under what
 *     name);
 *   - ./settings.js — any settings invalidation (targets, thresholds, the time
 *     zone that decides what "today" is).
 * A write this process did not see — another instance during a deploy — is
 * bounded by LEADERBOARD_TTL_MS. The day rolling over is the caller's
 * `isCurrent` check, because "today" changes without any write at all.
 *
 * A computation that overlapped an invalidation is returned to its callers but
 * NOT kept (the generation check): it may have read the database before the
 * write it raced, and keeping it would hide that write until the TTL.
 * Concurrent misses for one window share a single computation.
 *
 * Callers receive the SHARED cached object and must not modify it.
 *
 * A leaf module — no imports — so the data modules that invalidate it can never
 * form a cycle through it. Owned here and nowhere else.
 */

const LEADERBOARD_TTL_MS = 5 * 60 * 1000;
/** Distinct windows kept at once. The endpoint is public, so this is a bound, not a size. */
const MAX_WINDOWS = 32;

const answers = new Map(); // window key → { value, at }
const inFlight = new Map(); // window key → Promise
let generation = 0;

/** Something the board shows may have changed: the next read recomputes. */
function invalidateLeaderboardCache() {
  generation += 1;
  answers.clear();
  inFlight.clear();
}

/** Re-inserted on every refresh, so the window evicted first is the stalest one. */
function keep(key, value, at) {
  answers.delete(key);
  if (answers.size >= MAX_WINDOWS) answers.delete(answers.keys().next().value);
  answers.set(key, { value, at });
}

/**
 * The cached answer for `key`, or `compute()`'s, kept for next time.
 *
 * @param {string} key  one per window (today, a day, a range)
 * @param {() => Promise<object>} compute
 * @param {{ isCurrent?: (value: object) => boolean }} [options]
 *   `isCurrent` rejects a kept answer that has gone stale without any write —
 *   the "today" board after midnight.
 */
async function readThroughLeaderboard(key, compute, { isCurrent = () => true } = {}) {
  const now = Date.now();
  const kept = answers.get(key);
  if (kept && now - kept.at < LEADERBOARD_TTL_MS && isCurrent(kept.value)) return kept.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const startedIn = generation;
  const computation = (async () => {
    try {
      const value = await compute();
      if (startedIn === generation) keep(key, value, now);
      return value;
    } finally {
      if (inFlight.get(key) === computation) inFlight.delete(key);
    }
  })();
  inFlight.set(key, computation);
  return computation;
}

module.exports = {
  LEADERBOARD_TTL_MS,
  invalidateLeaderboardCache,
  readThroughLeaderboard,
};
