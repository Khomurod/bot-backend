/**
 * Fleet domain services — the single source of truth for calculations and
 * state transitions (§7, §13.3). Pages MUST NOT recompute these independently.
 */

'use strict';

// ── Response envelope (§11) ──────────────────────────────────────────────────
function envelope(data, { page = 1, pageSize = 20, total = null, source = 'primary-db', stale = false } = {}) {
  const generatedAt = '2026-07-03T18:00:00Z';
  return {
    data,
    page,
    pageSize,
    total: total == null ? (Array.isArray(data) ? data.length : 1) : total,
    meta: {
      source,
      generatedAt,
      lastSuccessfulSyncAt: '2026-07-03T17:59:50Z',
      stale,
    },
  };
}

// ── Error shape (§11.2) ──────────────────────────────────────────────────────
function apiError(res, httpStatus, code, message, { fieldErrors = {}, retryable = false } = {}) {
  return res.status(httpStatus).json({
    error: { code, message, fieldErrors, correlationId: `cid_${Date.now().toString(36)}`, retryable },
  });
}

// ── Load lifecycle state machine (§7.1) ──────────────────────────────────────
const LOAD_TRANSITIONS = {
  upcoming: ['dispatched', 'canceled', 'rejected'],
  dispatched: ['in_transit', 'canceled', 'rejected'],
  in_transit: ['delivered'],
  delivered: [],
  canceled: ['upcoming'], // reopen (manager + reason enforced at route layer)
  rejected: ['upcoming'],
};
function canTransitionLoad(from, to) {
  return Boolean(LOAD_TRANSITIONS[from] && LOAD_TRANSITIONS[from].includes(to));
}

// ── Task lifecycle (§7.2) ────────────────────────────────────────────────────
const TASK_TRANSITIONS = {
  todo: ['in_progress', 'archived'],
  in_progress: ['done', 'todo', 'archived'],
  done: ['in_progress', 'archived'],
  archived: ['todo'], // restore
};
function canTransitionTask(from, to) {
  return Boolean(TASK_TRANSITIONS[from] && TASK_TRANSITIONS[from].includes(to));
}

// ── Equipment state (§7.3) ───────────────────────────────────────────────────
const EQUIPMENT_TRANSITIONS = {
  available: ['assigned', 'maintenance', 'inactive'],
  assigned: ['in_transit', 'available', 'maintenance'],
  in_transit: ['available', 'maintenance'],
  maintenance: ['available', 'inactive'],
  inactive: [],
};
function canTransitionEquipment(from, to) {
  return Boolean(EQUIPMENT_TRANSITIONS[from] && EQUIPMENT_TRANSITIONS[from].includes(to));
}

// ── Finance formulas (§6.10, §10.8) — minor currency units (cents) ───────────
function rateSavings(haulingRate, assignedRate) {
  return (haulingRate || 0) - (assignedRate || 0);
}
function savingsLabel(savings) {
  return savings < 0 ? 'Loss/Over assignment' : 'Savings';
}
// RPM defined ONCE here: hauling revenue (dollars) per planned mile.
function rpm(haulingRateCents, distanceMiles) {
  if (!distanceMiles || distanceMiles <= 0) return 0;
  return Math.round((haulingRateCents / 100 / distanceMiles) * 100) / 100;
}
function finalBalance(rateSavingsCents, manualAdjustmentCents = 0) {
  return (rateSavingsCents || 0) + (manualAdjustmentCents || 0);
}

// ── ETA / timing (§6.7) — never store an ambiguous signed "delay" ────────────
function timingState(scheduleVarianceMinutes) {
  if (scheduleVarianceMinutes == null) return 'unknown';
  if (scheduleVarianceMinutes < -20) return 'early';
  if (scheduleVarianceMinutes > 20) return 'late';
  return 'on_time';
}
function timingLabel(scheduleVarianceMinutes) {
  const state = timingState(scheduleVarianceMinutes);
  if (state === 'unknown') return 'Unknown';
  if (state === 'on_time') return 'On Time';
  const mins = Math.abs(scheduleVarianceMinutes);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const dur = h > 0 ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
  return state === 'early' ? `Early by ${dur}` : `Late by ${dur}`;
}

// ── Data-freshness classification for a location observation (§10.6) ─────────
const STALE_LOCATION_MINUTES = 30;
function locationFreshness(observedAtIso, nowIso = '2026-07-03T18:00:00Z') {
  if (!observedAtIso) return 'unavailable';
  const ageMin = (new Date(nowIso).getTime() - new Date(observedAtIso).getTime()) / 60000;
  return ageMin > STALE_LOCATION_MINUTES ? 'stale' : 'fresh';
}

module.exports = {
  envelope,
  apiError,
  LOAD_TRANSITIONS,
  canTransitionLoad,
  TASK_TRANSITIONS,
  canTransitionTask,
  EQUIPMENT_TRANSITIONS,
  canTransitionEquipment,
  rateSavings,
  savingsLabel,
  rpm,
  finalBalance,
  timingState,
  timingLabel,
  locationFreshness,
  STALE_LOCATION_MINUTES,
};
