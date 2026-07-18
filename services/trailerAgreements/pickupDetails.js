/**
 * Pure normalization + validation of the ACTUAL pickup details an employee
 * records at "Confirm pickup" time.
 *
 * The guided pickup UI collects the real pickup date/time, location and (as an
 * advanced, optional pair) latitude/longitude. Historically the activation
 * request dropped all of it and billed from the scheduled data, silently losing
 * whatever the employee typed. This module turns the raw request body into the
 * exact fields activation should persist, applying the rules:
 *
 *   - coordinates are optional but must be supplied BOTH or NEITHER;
 *   - latitude ∈ [-90, 90], longitude ∈ [-180, 180];
 *   - a valid stored value is never overwritten with null/empty — an omitted
 *     field falls back to what the item already holds (planned value).
 *
 * No I/O here so the rules are testable in isolation.
 */
'use strict';

function httpError(message, status = 400, code) {
  return Object.assign(new Error(message), code ? { status, code } : { status });
}

/** Trimmed non-empty string, else null. */
function cleanText(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/**
 * Parse an optional coordinate pair. Returns { lat, lng } (numbers) when both
 * are supplied and valid, { lat: null, lng: null } when neither is supplied,
 * and throws 422 INVALID_COORDINATES otherwise.
 */
function parseCoordinates(rawLat, rawLng) {
  const latGiven = rawLat !== undefined && rawLat !== null && String(rawLat).trim() !== '';
  const lngGiven = rawLng !== undefined && rawLng !== null && String(rawLng).trim() !== '';
  if (!latGiven && !lngGiven) return { lat: null, lng: null };
  if (latGiven !== lngGiven) {
    throw httpError('Enter both latitude and longitude, or leave both empty.', 422, 'INVALID_COORDINATES');
  }
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw httpError('Latitude and longitude must be numbers.', 422, 'INVALID_COORDINATES');
  }
  if (lat < -90 || lat > 90) {
    throw httpError('Latitude must be between -90 and 90.', 422, 'INVALID_COORDINATES');
  }
  if (lng < -180 || lng > 180) {
    throw httpError('Longitude must be between -180 and 180.', 422, 'INVALID_COORDINATES');
  }
  return { lat, lng };
}

/**
 * Resolve the actual pickup values to persist from the request body and the
 * current item row. Never returns an empty string / null where the item already
 * had a good planned value.
 */
function resolveActualPickup(body = {}, item = {}) {
  const coords = parseCoordinates(body.pickup_lat, body.pickup_lng);

  let actualAt = null;
  if (body.actual_pickup_at) {
    const d = new Date(body.actual_pickup_at);
    if (Number.isNaN(d.getTime())) {
      throw httpError('The actual pickup time is not a valid date.', 422, 'INVALID_PICKUP_TIME');
    }
    actualAt = d;
  }
  // Billable/recorded pickup time: what the employee entered, else what was
  // already recorded, else the scheduled time.
  const effectiveActualAt = actualAt || item.actual_pickup_at || item.scheduled_pickup_at || null;

  // Location: keep a good planned value rather than blanking it.
  const location = cleanText(body.pickup_location) || cleanText(item.actual_pickup_location) || cleanText(item.pickup_location);

  // Coordinates: prefer supplied, else keep whatever the item already recorded.
  const lat = coords.lat !== null ? coords.lat
    : (item.actual_pickup_lat ?? item.pickup_lat ?? null);
  const lng = coords.lng !== null ? coords.lng
    : (item.actual_pickup_lng ?? item.pickup_lng ?? null);

  return {
    actual_pickup_at: effectiveActualAt,
    actual_pickup_location: location,
    actual_pickup_lat: lat,
    actual_pickup_lng: lng,
  };
}

module.exports = { parseCoordinates, resolveActualPickup };
