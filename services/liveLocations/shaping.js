/**
 * Live Locations shaping helpers — PURE functions, no I/O.
 *
 * Coordinate/number coercion, the order sort key, unit-number and driver-name
 * extraction from a group row, and the bounded-concurrency mapper that keeps ETA
 * fan-out from stampeding the geocoder.
 *
 * Split out of services/liveLocationsService.js, which re-exports several of
 * these for its unit tests.
 */
// samsara owns unit-number normalization; a second copy would let the map's
// matching drift away from the provider's.
const samsara = require('../samsaraLocationService');
const { extractDriverNameFromGroupTitle } = require('../../lib/drivers/driverGroupTitle');

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

function normalizeAddressKey(address) {
  return String(address || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Soonest still-relevant appointment (mirrors datatruckApiService ranking). */
function orderSortKey(order, now) {
  const appt = (kind) => {
    const iso = kind === 'pickup'
      ? (order?.pickup_time || order?.pickup_appointment_time)
      : (order?.delivery_time || order?.delivery_appointment_time);
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const pu = appt('pickup');
  const del = appt('delivery');
  if (pu != null && pu >= now) return pu;
  if (del != null && del >= now) return del;
  return Math.max(pu || 0, del || 0) + 1e15;
}

// ─── Unit enumeration ─────────────────────────────────────────────────────────

/**
 * The unit number for a group row. Prefer the stored `unit_number` column, but
 * fall back to parsing it out of the group title (e.g. "WENZE UNIT # 305 …") —
 * the same source the working bot /location path uses. Without this fallback a
 * group whose unit_number column was never backfilled would silently drop out
 * of the snapshot even though Samsara has its GPS.
 */
function unitNumberForRow(row) {
  const fromColumn = samsara.normalizeUnitNumber(row.unit_number);
  if (fromColumn) return fromColumn;
  const title = row.raw_group_title || row.group_name || '';
  return samsara.normalizeUnitNumber(samsara.extractUnitNumberFromGroupName(title));
}

function driverNameForGroupRow(row) {
  const explicit = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  if (explicit) return explicit;
  return extractDriverNameFromGroupTitle(row.raw_group_title || row.group_name || '');
}

function telegramGroupLinkFor(row) {
  const username = String(row.telegram_username || '').replace(/^@/, '').trim();
  return username ? `https://t.me/${username}` : null;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = new Array(workerCount).fill(null).map(async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  toNumberOrNull,
  round,
  toIso,
  normalizeAddressKey,
  orderSortKey,
  unitNumberForRow,
  driverNameForGroupRow,
  telegramGroupLinkFor,
  mapWithConcurrency,
};
