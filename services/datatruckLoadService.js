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
 * Datatruck order field names are not fully documented and vary by account, so
 * pluck defensively across the known aliases. No AI, no OCR — structured JSON in,
 * structured stops out.
 */
function extractStopsFromOrder(order) {
  const trip = order?.trip || {};
  return {
    pickupAddress: firstNonEmpty(
      order?.pickup_location,
      order?.pickup_address,
      order?.origin,
      trip.pickup_location
    ),
    deliveryAddress: firstNonEmpty(
      order?.delivery_location,
      order?.delivery_address,
      order?.destination,
      trip.delivery_location
    ),
    pickupTime: order?.pickup_time || order?.pickup_appointment_time || null,
    deliveryTime: order?.delivery_time || order?.delivery_appointment_time || null,
    shipperName: firstNonEmpty(order?.shipper, order?.shipper_name),
    receiverName: firstNonEmpty(order?.receiver, order?.consignee, order?.receiver_name),
  };
}

function extractLoadIdentifier(order) {
  return firstNonEmpty(
    order?.order_number,
    order?.reference_number,
    order?.reference,
    order?.load_number,
    order?.po_number,
    order?.id != null ? String(order.id) : ''
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
    status: status || null,
    miles: miles || null,
    pickupAddress: stops.pickupAddress,
    deliveryAddress: stops.deliveryAddress,
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

/** Test/maintenance helper — drop the in-memory cache. */
function clearCache() {
  loadCache.clear();
}

module.exports = {
  isConfigured,
  driverNameFromGroup,
  extractStopsFromOrder,
  extractLoadFromOrder,
  extractLoadIdentifier,
  resolveActiveLoadForDriver,
  resolveActiveLoadForGroup,
  getAdminRecentLoadsForGroup,
  clearCache,
  CACHE_TTL_MS,
};
