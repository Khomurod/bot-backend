/**
 * FleetView status normalizer — the SINGLE source of truth for load/driver
 * status business rules across the whole app (map, boards, dashboards,
 * statistics, filters).
 *
 * Core business rule (decided by the operations team):
 *   - "Dispatched" means the driver is currently LOADED — the dispatched load is
 *     the driver's current, active load. It must never be treated as empty,
 *     idle, pending, or unknown anywhere in FleetView.
 *
 * Every module that needs to decide whether a driver is loaded / empty /
 * active / current-load MUST use these helpers instead of re-deriving the rule.
 * The DataTruck adapter and the real-mode provider both delegate their status
 * mapping here so the canonical vocabulary is defined in exactly one place.
 */

'use strict';

// Canonical FleetView load statuses.
const STATUS = Object.freeze({
  UPCOMING: 'upcoming',
  DISPATCHED: 'dispatched',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  CANCELED: 'canceled',
  UNKNOWN: 'unknown',
});

const KNOWN = new Set(Object.values(STATUS));

/**
 * Normalize a raw upstream status string into a canonical FleetView status.
 *
 * `fallback` is what an unrecognized/empty status maps to. Historically the
 * DataTruck mappers fell back to 'dispatched'; callers that need that exact
 * behavior pass it explicitly. New code should prefer 'unknown' so odd statuses
 * surface visibly instead of silently masquerading as an active load.
 */
function normalizeLoadStatus(raw, { fallback = STATUS.UNKNOWN } = {}) {
  const s = String(raw || '').toLowerCase();
  if (!s) return fallback;
  if (s.includes('deliver') || s.includes('complete')) return STATUS.DELIVERED;
  if (s.includes('transit') || s.includes('enroute') || s.includes('en route') || s.includes('picked')) return STATUS.IN_TRANSIT;
  if (s.includes('cancel')) return STATUS.CANCELED;
  if (s.includes('dispatch') || s.includes('assign') || s.includes('booked') || s.includes('cover')) return STATUS.DISPATCHED;
  if (s.includes('pend') || s.includes('open') || s.includes('avail') || s.includes('upcoming')) return STATUS.UPCOMING;
  return fallback;
}

function isKnownStatus(status) {
  return KNOWN.has(String(status || '').toLowerCase());
}

/**
 * Is the driver currently LOADED? Dispatched (current load) and in-transit both
 * mean the driver is carrying an active load. This is THE loaded/empty decision
 * for the map, boards and dashboards.
 */
function isLoaded(status) {
  const s = normalizeLoadStatus(status, { fallback: status });
  return s === STATUS.DISPATCHED || s === STATUS.IN_TRANSIT;
}

/** The load is the driver's current active load (dispatched or moving). */
function isCurrentLoad(status) {
  return isLoaded(status);
}

function isDelivered(status) {
  return normalizeLoadStatus(status, { fallback: status }) === STATUS.DELIVERED;
}

function isCanceled(status) {
  return normalizeLoadStatus(status, { fallback: status }) === STATUS.CANCELED;
}

/**
 * Whether a load's revenue counts toward "gross" on the Gross Board.
 * Business rule: delivered + in-transit, and — because Dispatched = loaded /
 * current active load — dispatched loads count too (revenue already committed
 * and in motion). Upcoming, canceled and unknown do not count.
 */
function countsAsGross(status) {
  const s = normalizeLoadStatus(status, { fallback: status });
  return s === STATUS.DELIVERED || s === STATUS.IN_TRANSIT || s === STATUS.DISPATCHED;
}

/**
 * Map condition for a driver marker. Drives marker colour + the map's
 * All/Empty/Finishing/Loaded segments.
 *   - stale GPS wins visually (operator needs to know the ping is old)
 *   - dispatched/in-transit → 'loaded' (the Dispatched-is-loaded rule)
 *   - delivered but still tracked → 'finishing'
 *   - no active load → 'empty'
 */
function mapCondition({ status, hasLoad = false, gpsStale = false } = {}) {
  if (gpsStale) return 'stale';
  if (isLoaded(status)) return 'loaded';
  if (hasLoad && isDelivered(status)) return 'finishing';
  return 'empty';
}

/** Human label for a driver's loaded/empty state (cards, tooltips). */
function loadedLabel(status, hasLoad = false) {
  if (isLoaded(status)) return 'Loaded';
  if (hasLoad && isDelivered(status)) return 'Finishing';
  if (hasLoad) return 'Has load';
  return 'Empty';
}

module.exports = {
  STATUS,
  normalizeLoadStatus,
  isKnownStatus,
  isLoaded,
  isCurrentLoad,
  isDelivered,
  isCanceled,
  countsAsGross,
  mapCondition,
  loadedLabel,
};
