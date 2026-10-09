'use strict';

/**
 * Economy mode — which background work stands down while the database's
 * monthly transfer allowance is nearly spent, and until when.
 *
 * WHY IT EXISTS. October 2026: the hosted database (Supabase, Free plan, grace
 * period over) had used 4.8 of its 5 GB monthly egress with eleven days left in
 * the cycle, while the application was spending 0.3–0.45 GB a day. Going over
 * restricts the database outright — every feature stops, not just the costly
 * ones. The owner chose to keep the driver chats, Samsara alerts, candidate
 * leads, money codes and scheduled broadcasts running, and to stand everything
 * else down until the allowance resets.
 *
 * ONLY AN EXPLICIT, DATED SWITCH TURNS IT ON. `ECONOMY_MODE_UNTIL` must hold an
 * ISO date-time; unset, unreadable or past means OFF. There is no default date
 * in the code on purpose: a hidden date would make the test suite's behaviour
 * depend on the day it runs, and would quietly pause features on any machine
 * that happened to run this before that day.
 *
 * A DATE TOO FAR AHEAD IS A TYPO, NOT A PLAN. More than `MAX_ECONOMY_DAYS` away
 * reads as OFF, loudly: `2027-10-21` for `2026-10-21` would otherwise pause
 * half the application for a year, and nothing that would notice — the health
 * block, the self-healing watch — runs while economy mode is on. "Away" is
 * measured from when the process STARTED, which on Render is when the variable
 * was last saved: measured from the current clock, the same typo left in place
 * would quietly come of age forty-five days before it and switch itself on.
 *
 * Pure: no I/O, no clock of its own, no state. `services/operations/economy.js`
 * supplies the environment and the time.
 */

/** Longest economy window that is believed rather than treated as a typo. */
const MAX_ECONOMY_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Catalogue keys (`lib/operations/backgroundServiceCatalog.js`) that do not run
 * at all while economy mode is on. The owner's list, 2026-10-09: BOL/POD,
 * load control, the automatic checks and questions, fuel, retention, and the
 * AI checks. Everything NOT here keeps running.
 */
const ECONOMY_PAUSED_KEYS = Object.freeze([
  // BOL/POD forwarding
  'datatruck_documents',
  // load control
  'load_lifecycle',
  // the automatic checks and the questions they raise
  'consistency_sweep',
  'contradiction_pass',
  'control_ask_pass',
  'control_daily_digest',
  'self_healing',
  'learning_pass',
  'duplicate_unit_scan',
  'decision_verification',
  // fuel
  'fuel_risk',
  'fuel_stop_alerts',
  // driver retention
  'retention_watch',
  'chat_annotation',
  // the AI checks
  'group_status_ai',
  'ai_model_maintenance',
  'ai_policy_watcher',
  'safety_coach',
]);
const PAUSED = new Set(ECONOMY_PAUSED_KEYS);

/**
 * Work that keeps running in economy mode, but slower.
 *
 * The Dispatcher Board read is not paused because the Sunday driver-raise
 * review refuses a Board older than six hours (`MAX_BOARD_AGE_HOURS` in
 * services/raise/boardRoster.js) — stopping the read would stop the review.
 * Every four hours keeps it fresh for that with room for one failed read.
 * The home-in/home-out pass reads the same snapshot, so it follows the read.
 */
const ECONOMY_SLOW_INTERVAL_MS = Object.freeze({
  dispatch_board_poll: 4 * 60 * 60 * 1000,
  home_time_board_presence: 4 * 60 * 60 * 1000,
});

/**
 * @param {{ env?: object, now?: number, startedAt?: number }} input
 *   `startedAt` — when the process (and so the setting) started; defaults to `now`.
 * @returns {{ active: boolean, until: string|null, untilMs: number|null, problem: string|null }}
 *   `problem` names why a value that WAS set is not being honoured.
 */
function resolveEconomy({ env = {}, now = Date.now(), startedAt = now } = {}) {
  const raw = String(env.ECONOMY_MODE_UNTIL ?? '').trim();
  const off = (problem = null) => ({ active: false, until: null, untilMs: null, problem });
  if (!raw || raw.toLowerCase() === 'off') return off();

  const untilMs = Date.parse(raw);
  if (!Number.isFinite(untilMs)) return off(`ECONOMY_MODE_UNTIL is not a date: "${raw.slice(0, 40)}"`);
  if (untilMs - startedAt > MAX_ECONOMY_DAYS * DAY_MS) {
    return off(`ECONOMY_MODE_UNTIL is more than ${MAX_ECONOMY_DAYS} days away (${raw.slice(0, 40)}) — `
      + 'treated as a typo, economy mode is OFF');
  }
  if (untilMs <= now) return off();
  return { active: true, until: new Date(untilMs).toISOString(), untilMs, problem: null };
}

/** Is this catalogue key one that economy mode stands down? */
function isEconomyPausedKey(serviceKey) {
  return PAUSED.has(serviceKey);
}

/** The sentence a paused pass reports instead of running, or null when it may run. */
function economyPauseReason(serviceKey, state) {
  if (!state?.active || !PAUSED.has(serviceKey)) return null;
  return `paused to save database traffic until ${state.until}`;
}

/**
 * How long to wait between passes: the slower economy interval, never faster
 * than normal. A pass that FAILED retries at its normal pace: the slow interval
 * is for a healthy read, never a reason to sit on a broken one — the Sunday
 * raise review refuses a Board whose last read failed, however recent the
 * snapshot before it.
 */
function economyIntervalMs(serviceKey, normalMs, state, { failed = false } = {}) {
  if (!state?.active || failed) return normalMs;
  const slow = ECONOMY_SLOW_INTERVAL_MS[serviceKey];
  return slow ? Math.max(normalMs, slow) : normalMs;
}

module.exports = {
  ECONOMY_PAUSED_KEYS,
  ECONOMY_SLOW_INTERVAL_MS,
  MAX_ECONOMY_DAYS,
  resolveEconomy,
  isEconomyPausedKey,
  economyPauseReason,
  economyIntervalMs,
};
