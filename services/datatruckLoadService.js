/**
 * Datatruck load resolution service.
 *
 * Sources a driver's current/active load straight from the Datatruck OpenAPI
 * instead of parsing Telegram messages, images (OCR), or free text with AI.
 * Given a driver group (matched by driver name, exactly like the mileage and
 * location-monitor services), it returns the active order's pickup/delivery
 * locations, appointment times, status, miles, and reference/order number in
 * the same public shape the load-context consumers already expect.
 *
 * Read-only. Fails soft: when Datatruck is not configured (no API token /
 * company) every entry point cleanly returns null / [] and logs nothing noisy,
 * mirroring mileageBonusService. Results are memoized per driver for a short
 * TTL so the several consumers (ETA snapshots, location monitor, /load, admin
 * diagnostics) share one lookup and stay well under the API's rate limit.
 */
const datatruck = require('./datatruckApiService');
const { inferWindowsFromAiDateTimeStrings } = require('./loadWindowParse');
const { extractDriverNameFromGroupTitle } = require('./driverGroupTitle');

// A driver's active order changes on the scale of hours, not seconds. A few
// minutes of caching collapses the many on-demand reads into one API call.
const CACHE_TTL_MS = 3 * 60 * 1000;

/** normalizedDriverName -> { at: epochMs, load: object|null } */
const loadCache = new Map();

function isConfigured() {
  return datatruck.isConfigured();
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toMiles(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

/**
 * Best-effort driver name for a group row. Prefers explicit driver name columns
 * (present on some joined queries), else parses the Telegram group title the
 * same way the location monitor does.
 */
function driverNameFromGroup(group) {
  if (!group) return '';
  const explicit = firstNonEmpty(
    [group.driver_first_name, group.driver_last_name].filter(Boolean).join(' '),
    [group.first_name, group.last_name].filter(Boolean).join(' ')
  );
  if (explicit) return explicit;
  return extractDriverNameFromGroupTitle(group.group_name || '');
}

/**
 * Turn a Datatruck structured location object into a single geocodable address
 * line. The live API returns rich stop/location objects like:
 *   { company, address1, address2, city, state, zip_code, latitude, longitude }
 * `address1` is usually already a full "street, city, ST zip" string; when it is
 * missing we assemble one from the city/state/zip parts.
 */
function formatStructuredAddress(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const line1 = firstNonEmpty(loc.address1, loc.address, loc.formatted_address);
  if (line1) return line1;
  const parts = [loc.city, loc.state, loc.zip_code || loc.zip]
    .map(normalizeText)
    .filter(Boolean);
  return parts.join(', ');
}

function toCoord(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function structuredCoords(loc) {
  if (!loc || typeof loc !== 'object') return { lat: null, lng: null };
  return {
    lat: toCoord(loc.latitude ?? loc.lat),
    lng: toCoord(loc.longitude ?? loc.lng ?? loc.lon),
  };
}

/** First `stops[]` entry whose stop_type matches (case-insensitive). */
function findStopByType(order, type) {
  const stops = Array.isArray(order?.stops) ? order.stops : [];
  const wanted = String(type).toLowerCase();
  const matches = stops
    .filter((s) => String(s?.stop_type || '').toLowerCase() === wanted)
    .sort((a, b) => (Number(a?.ordering) || 0) - (Number(b?.ordering) || 0));
  return matches[0] || null;
}

/**
 * Extract pickup/delivery stops from a Datatruck order.
 *
 * The live Datatruck OpenAPI carries stop details in structured objects rather
 * than the flat `pickup_location` / `origin` fields this originally assumed:
 *   - `order.trip.pickup` / `order.trip.delivery` — the primary structured stops
 *     (company, address1, city/state/zip, latitude, longitude), OR
 *   - `order.stops[]` — every stop with a `stop_type` and nested `location`.
 * Appointment times live at the top level (`pickup_time` / `delivery_time`).
 *
 * We still read the legacy flat aliases first so any pre-existing/simple order
 * shape keeps working; the structured fields fill in when the flat ones are
 * absent (which is the real API's behavior). Coordinates are captured so ETA can
 * skip geocoding entirely when Datatruck already knows the stop's lat/lng.
 */
function extractStopsFromOrder(order) {
  const trip = order?.trip || {};
  const pickupStop = findStopByType(order, 'pickup');
  const deliveryStop = findStopByType(order, 'delivery');
  const pickupLoc = trip.pickup || pickupStop?.location || null;
  const deliveryLoc = trip.delivery || deliveryStop?.location || null;

  const pickupCoords = structuredCoords(pickupLoc);
  const deliveryCoords = structuredCoords(deliveryLoc);

  return {
    pickupAddress: firstNonEmpty(
      order?.pickup_location,
      order?.pickup_address,
      order?.origin,
      trip.pickup_location,
      formatStructuredAddress(pickupLoc)
    ),
    deliveryAddress: firstNonEmpty(
      order?.delivery_location,
      order?.delivery_address,
      order?.destination,
      trip.delivery_location,
      formatStructuredAddress(deliveryLoc)
    ),
    pickupLat: pickupCoords.lat,
    pickupLng: pickupCoords.lng,
    deliveryLat: deliveryCoords.lat,
    deliveryLng: deliveryCoords.lng,
    pickupTime: order?.pickup_time
      || order?.pickup_appointment_time
      || pickupStop?.ready_time_start_date
      || null,
    deliveryTime: order?.delivery_time
      || order?.delivery_appointment_time
      || deliveryStop?.ready_time_start_date
      || null,
    shipperName: firstNonEmpty(order?.shipper, order?.shipper_name, pickupLoc?.company),
    receiverName: firstNonEmpty(
      order?.receiver,
      order?.consignee,
      order?.receiver_name,
      deliveryLoc?.company
    ),
  };
}

function extractLoadIdentifier(order) {
  return firstNonEmpty(
    order?.order_number,
    order?.reference_number,
    order?.reference,
    order?.load_number,
    order?.po_number,
    // Live Datatruck orders identify the load by `load_id` (the human load
    // number) and `shipment_id` (e.g. "DT-010357"); prefer those over the raw
    // primary-key `id` so /load and the map show a recognizable number.
    order?.load_id,
    order?.shipment_id,
    order?.id != null ? String(order.id) : ''
  ) || null;
}

/**
 * The unit / truck number assigned to an order, as a raw label. The live API
 * carries it on the trip (`truck__unit_number`, e.g. "771 JAFAR") or on
 * `assigned_driver_n_truck.truck_unit_number`. Callers normalize it themselves.
 */
function extractUnitNumberRaw(order) {
  const trip = order?.trip || {};
  return firstNonEmpty(
    trip.truck__unit_number,
    order?.assigned_driver_n_truck?.truck_unit_number,
    order?.truck_unit_number,
    order?.unit_number
  ) || null;
}

/**
 * Normalize a raw Datatruck order into the load-context shape shared by
 * dispatchPinnedContextService consumers (pickupSummary / deliverySummary /
 * destinationQuery / windows / loadInfoComplete) plus the extra Datatruck-native
 * fields (orderId, status, miles, reference, stop addresses/times).
 */
function extractLoadFromOrder(order) {
  if (!order) return null;
  const trip = order.trip || {};
  const stops = extractStopsFromOrder(order);

  const pickupSummary = [stops.pickupAddress, normalizeText(stops.pickupTime)]
    .filter(Boolean)
    .join(' | ');
  const deliverySummary = [stops.deliveryAddress, normalizeText(stops.deliveryTime)]
    .filter(Boolean)
    .join(' | ');
  const destinationQuery = stops.deliveryAddress || stops.pickupAddress || '';

  const windows = inferWindowsFromAiDateTimeStrings(
    stops.pickupTime ? String(stops.pickupTime) : '',
    stops.deliveryTime ? String(stops.deliveryTime) : ''
  );

  const orderId = order.id != null ? String(order.id) : null;
  const status = firstNonEmpty(order.status, order.order_status, trip.status);
  const miles = toMiles(trip.mile ?? order.total_miles ?? trip.miles);

  return {
    source: 'datatruck',
    orderId,
    loadIdentifier: extractLoadIdentifier(order),
    unitNumber: extractUnitNumberRaw(order),
    status: status || null,
    miles: miles || null,
    pickupAddress: stops.pickupAddress,
    deliveryAddress: stops.deliveryAddress,
    pickupLat: stops.pickupLat,
    pickupLng: stops.pickupLng,
    deliveryLat: stops.deliveryLat,
    deliveryLng: stops.deliveryLng,
    pickupTime: stops.pickupTime,
    deliveryTime: stops.deliveryTime,
    shipperName: stops.shipperName,
    receiverName: stops.receiverName,
    pickupSummary,
    deliverySummary,
    destinationQuery,
    pickupWindowStart: windows.pickup_window_start,
    pickupWindowEnd: windows.pickup_window_end,
    deliveryWindowStart: windows.delivery_window_start,
    deliveryWindowEnd: windows.delivery_window_end,
    loadInfoComplete: Boolean(pickupSummary && deliverySummary && destinationQuery),
  };
}

/**
 * Which stop the truck is heading to next, derived purely from the load's
 * windows/addresses (no GPS). Shared by /load, /status, and the Live Locations
 * map so every consumer computes "next stop" identically. Returns null when the
 * load has no usable stop.
 */
function getNextStop(load, { nowMs = Date.now() } = {}) {
  if (!load) return null;
  const pickupEndMs = load.pickupWindowEnd
    ? Date.parse(load.pickupWindowEnd instanceof Date ? load.pickupWindowEnd.toISOString() : load.pickupWindowEnd)
    : NaN;
  const pickupPassed = Number.isFinite(pickupEndMs) && nowMs > pickupEndMs;
  const hasPickup = Boolean(load.pickupAddress);
  const hasDelivery = Boolean(load.deliveryAddress);

  let type = null;
  if (hasPickup && !pickupPassed) type = 'pickup';
  else if (hasDelivery) type = 'delivery';
  else if (hasPickup) type = 'pickup';
  else return null;

  const isPickup = type === 'pickup';
  return {
    type,
    name: (isPickup ? load.shipperName : load.receiverName) || null,
    address: (isPickup ? load.pickupAddress : load.deliveryAddress) || null,
    lat: isPickup ? (load.pickupLat ?? null) : (load.deliveryLat ?? null),
    lng: isPickup ? (load.pickupLng ?? null) : (load.deliveryLng ?? null),
    appointmentStart: isPickup ? load.pickupWindowStart : load.deliveryWindowStart,
    appointmentEnd: isPickup ? load.pickupWindowEnd : load.deliveryWindowEnd,
  };
}

/** The load's current status string, or null. */
function getLoadStatus(load) {
  return load && load.status ? load.status : null;
}

/**
 * Resolve the active load for a driver by name. Cached per driver for
 * CACHE_TTL_MS. Returns null when Datatruck is unconfigured, the name is empty,
 * no order matches, or the lookup fails (last good value is reused on error).
 */
async function resolveActiveLoadForDriver(driverName, { nowMs = Date.now() } = {}) {
  if (!isConfigured()) return null;
  const name = normalizeText(driverName);
  if (!name) return null;

  const key = datatruck.normalizeNameForMatch(name);
  if (!key) return null;

  const cached = loadCache.get(key);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) {
    return cached.load;
  }

  let order = null;
  try {
    order = await datatruck.fetchActiveOrderForDriver(name, { nowMs });
  } catch (err) {
    console.warn(`[DATATRUCK-LOAD] Active-order lookup failed for "${name}":`, err.message);
    return cached ? cached.load : null;
  }

  const load = order ? extractLoadFromOrder(order) : null;
  loadCache.set(key, { at: nowMs, load });
  return load;
}

/** Resolve the active load for a driver group (derives the driver name first). */
async function resolveActiveLoadForGroup(group, { nowMs = Date.now() } = {}) {
  if (!isConfigured()) return null;
  const driverName = driverNameFromGroup(group);
  if (!driverName) return null;
  return resolveActiveLoadForDriver(driverName, { nowMs });
}

/** normalizedUnit -> { at, load } */
const unitLoadCache = new Map();

/**
 * Resolve the active load for a UNIT/truck number. Cached per unit for
 * CACHE_TTL_MS. Returns null when Datatruck is unconfigured, the unit is empty,
 * no order matches, or the lookup fails (last good value reused on error).
 */
async function resolveActiveLoadForUnit(unitNumber, { nowMs = Date.now() } = {}) {
  if (!isConfigured()) return null;
  const key = datatruck.normalizeUnitForMatch(unitNumber);
  if (!key) return null;

  const cached = unitLoadCache.get(key);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.load;

  let order = null;
  try {
    order = await datatruck.fetchActiveOrderForUnit(key, { nowMs });
  } catch (err) {
    console.warn(`[DATATRUCK-LOAD] Active-order lookup failed for unit "${key}":`, err.message);
    return cached ? cached.load : null;
  }
  const load = order ? extractLoadFromOrder(order) : null;
  unitLoadCache.set(key, { at: nowMs, load });
  return load;
}

/**
 * Admin-diagnostics view: the group's active Datatruck load(s) mapped to the
 * exact `recentLoads` row shape the dispatch testing panel already renders.
 * Empty array when there is nothing to show (unconfigured / no match).
 */
async function getAdminRecentLoadsForGroup(group, opts = {}) {
  const load = await resolveActiveLoadForGroup(group, opts);
  if (!load) return [];
  const iso = (value) => {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  };
  return [
    {
      id: load.orderId,
      telegramMessageId: null,
      createdAt: null,
      sourceMessageAt: null,
      loadIdentifier: load.loadIdentifier,
      pickupSummary: load.pickupSummary || '',
      deliverySummary: load.deliverySummary || '',
      destinationQuery: load.destinationQuery || '',
      pickupWindowStart: iso(load.pickupWindowStart),
      pickupWindowEnd: iso(load.pickupWindowEnd),
      deliveryWindowStart: iso(load.deliveryWindowStart),
      deliveryWindowEnd: iso(load.deliveryWindowEnd),
      captionPreview: load.status ? `Status: ${load.status}` : '',
      aiModel: '',
    },
  ];
}

/** Test/maintenance helper — drop the in-memory caches. */
function clearCache() {
  loadCache.clear();
  unitLoadCache.clear();
}

module.exports = {
  isConfigured,
  driverNameFromGroup,
  extractStopsFromOrder,
  extractLoadFromOrder,
  extractLoadIdentifier,
  extractUnitNumberRaw,
  resolveActiveLoadForDriver,
  resolveActiveLoadForGroup,
  resolveActiveLoadForUnit,
  getNextStop,
  getLoadStatus,
  getAdminRecentLoadsForGroup,
  clearCache,
  CACHE_TTL_MS,
  // ─── Shared "current load" service surface ─────────────────────────────────
  // Stable, intention-revealing names for the one place every feature reads a
  // driver/unit's current load from Datatruck. These are thin aliases over the
  // resolve* functions above so /load, /status, dispatch ETA, and Live Locations
  // all share the same source of truth and the same short-TTL cache.
  getCurrentLoadByDriver: resolveActiveLoadForDriver,
  getCurrentLoadByUnit: resolveActiveLoadForUnit,
  getCurrentLoadByGroup: resolveActiveLoadForGroup,
};
