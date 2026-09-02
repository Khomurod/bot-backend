/**
 * Fuel Monitor decision rules — PURE functions, no database, network or AI.
 *
 * This is the cheap-first half of detection that keeps the feature affordable:
 * `messageHasFuelHeader` and `extractStationFromText` reject or resolve most
 * posts with no AI call at all, and `computeNextCheck` decides how long the
 * poller may sleep from distance and speed alone.
 *
 * Being pure is the point — the scheduling arithmetic and the header rules are
 * the parts worth asserting on directly (tests/fuelStop*.test.js).
 *
 * Split out of services/fuelStopAlertService.js, which re-exports these.
 */
const {
  NEAR_GAP_MIN, MIN_GAP_MIN, MAX_GAP_MIN, RETRY_GAP_MIN, SPEED_MIN_MPH, SPEED_MAX_MPH,
  AVG_SPEED_MPH, ROAD_FACTOR, PRE_ARRIVAL_LEAD_MIN, DEFAULT_RADIUS_MILES,
  FUEL_HEADER_RE, ADDRESS_RE,
} = require('./constants');

function normalizeText(value) {
  return String(value || '').trim();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDriverDisplayName(row) {
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim();
  return name || 'Driver';
}

function milesLabel(distanceMiles) {
  if (!Number.isFinite(distanceMiles)) return 'a few';
  if (distanceMiles < 1) return 'less than 1';
  return String(Math.round(distanceMiles));
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function minutesFromNowIso(minutes) {
  return new Date(Date.now() + Math.max(0, minutes) * 60_000).toISOString();
}

/**
 * Decide when to next evaluate a watch row, or that it is already within range.
 * Pure (no I/O): pass nowMs. Returns either { withinRadius: true } or
 * { minutesToBoundary, etaBoundaryAtMs, nextCheckAtMs }.
 */
function computeNextCheck({ distanceMiles, radiusMiles = DEFAULT_RADIUS_MILES, speedMph, nowMs }) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const radius = Number.isFinite(radiusMiles) ? radiusMiles : DEFAULT_RADIUS_MILES;
  if (!(Number(distanceMiles) > radius)) {
    return { withinRadius: true };
  }
  const milesBeyond = Number(distanceMiles) - radius;
  const speed = (Number.isFinite(speedMph) && speedMph > SPEED_MIN_MPH)
    ? clamp(speedMph, SPEED_MIN_MPH, SPEED_MAX_MPH)
    : AVG_SPEED_MPH;
  const minutesToBoundary = (milesBeyond * ROAD_FACTOR / speed) * 60;
  const etaBoundaryAtMs = now + minutesToBoundary * 60_000;

  // Far away → wake ~20 min before predicted arrival. Close → poll tightly.
  let gapMin = minutesToBoundary > (PRE_ARRIVAL_LEAD_MIN + NEAR_GAP_MIN + 2)
    ? minutesToBoundary - PRE_ARRIVAL_LEAD_MIN
    : NEAR_GAP_MIN;
  gapMin = clamp(gapMin, MIN_GAP_MIN, MAX_GAP_MIN);

  return {
    withinRadius: false,
    minutesToBoundary,
    etaBoundaryAtMs,
    nextCheckAtMs: now + gapMin * 60_000,
  };
}

/** The raw text of a message (text or caption), trimmed. */
function messageText(message) {
  return normalizeText(message?.text || message?.caption || '');
}

/**
 * True only when the message STARTS with the Fuel Monitoring Department banner
 * (its first non-empty line). Case-insensitive and tolerant of the surrounding
 * emojis/whitespace. This is the sole trigger for the whole feature.
 */
function messageHasFuelHeader(text) {
  const firstLine = (String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)) || '';
  return FUEL_HEADER_RE.test(firstLine);
}

/**
 * Pull a station name + street address out of an already-confirmed fuel
 * message using regex only (no AI, no network). Returns { stationName, address }
 * with empty strings when nothing is found.
 */
function extractStationFromText(text) {
  const raw = String(text || '');
  const addressMatch = raw.match(ADDRESS_RE);
  const address = addressMatch ? normalizeText(addressMatch[0]) : '';

  // Station name usually follows a "⛽: <name>" / ": <name>" line under the
  // banner (e.g. "⛽ : Loves Travel Stop"). Best-effort only.
  let stationName = '';
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^[^A-Za-z0-9]*:?\s*([A-Za-z][A-Za-z0-9 '&./-]{2,60})$/);
    if (m && !FUEL_HEADER_RE.test(lines[i]) && !/please|fuel up|good day|station/i.test(lines[i])) {
      stationName = normalizeText(m[1]);
      break;
    }
  }
  return { stationName, address };
}

/** True when the driver profile is an active company driver (Fuel Monitor scope). */
function isCompanyDriverProfile(profile) {
  return Boolean(profile)
    && profile.driver_type === 'company_driver'
    && profile.status !== 'inactive';
}

module.exports = {
  normalizeText,
  escapeHtml,
  buildDriverDisplayName,
  milesLabel,
  clamp,
  minutesFromNowIso,
  computeNextCheck,
  messageText,
  messageHasFuelHeader,
  extractStationFromText,
  isCompanyDriverProfile,
};
