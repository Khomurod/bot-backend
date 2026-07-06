/**
 * FleetView DataTruck adapter — READ-ONLY.
 *
 * Live-verified against the DataTruck OpenAPI (wenze tenant):
 *   - drivers/list/  : full roster incl. assigned_dispatcher/truck/trailer, contact
 *   - trucks/list/   : 100+ trucks with unit/vin/plate/make/model/year/status
 *   - trailers/list/ : trailers with the same shape
 *   - orders/        : loads with load_pay/total_pay (dollars), per_mile_revenue,
 *                      customer__company_name, dispatcher__full_name, stops,
 *                      pickup/delivery windows — filter form
 *                      [{column, value:'start,end', contains:'between_datetime'}]
 *                      (the exact shape proven by services/datatruckApiService.js)
 *
 * Credentials come from the main app's existing config (DATATRUCK_API_TOKEN /
 * DATATRUCK_COMPANY); nothing new is required and nothing is ever hardcoded.
 * Every request is a GET. Results are cached (single-flight, stale-on-error)
 * to respect the documented ~20 req/min limit. This module never mutates
 * DataTruck and never exposes the token.
 */

'use strict';

const PAGE_SIZE = 100;
const PAGE_SPACING_MS = 3100; // stay under 20 req/min with headroom
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 12;
const TTL = { trucks: 15 * 60_000, trailers: 15 * 60_000, drivers: 15 * 60_000, orders: 5 * 60_000 };

function creds() {
  // Prefer the main app's config (already loaded in production); fall back to
  // plain env so this module never crashes outside the main-app process.
  try {
    const cfg = require('../../config/config');
    if (cfg.datatruckApiToken && cfg.datatruckCompany) return { token: cfg.datatruckApiToken, company: cfg.datatruckCompany };
  } catch (e) { /* config unavailable outside the main app */ }
  const token = process.env.DATATRUCK_API_TOKEN;
  const company = String(process.env.DATATRUCK_COMPANY || 'wenze').trim().toLowerCase();
  return token ? { token, company } : null;
}
function isConfigured() { return !!creds(); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, token) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return res.json();
      const err = new Error(`Datatruck ${res.status}`);
      err.status = res.status;
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, 30_000) : 1500 * attempt);
    } catch (err) {
      lastErr = err;
      if (!(err.name === 'AbortError' || err.name === 'TimeoutError' || err instanceof TypeError) || attempt === 3) throw err;
      await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

async function fetchPaged(path, { filter, ordering } = {}) {
  const c = creds();
  if (!c) throw new Error('DataTruck is not configured');
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
  if (filter) params.set('filter', filter);
  if (ordering) params.set('ordering', ordering);
  let url = `https://${c.company}.datatruck.io/api/v1/openapi/${path}?${params}`;
  const rows = [];
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    if (pages > 0) await sleep(PAGE_SPACING_MS);
    const data = await fetchJson(url, c.token);
    if (Array.isArray(data && data.results)) rows.push(...data.results);
    url = (data && data.next) || null;
    pages += 1;
  }
  return rows;
}

// ── caches: single-flight + stale-on-error ───────────────────────────────────
const cache = {}; // key → { at, data, inflight }
async function cached(key, ttl, loader) {
  const slot = cache[key] || (cache[key] = { at: 0, data: null, inflight: null });
  if (slot.data && Date.now() - slot.at < ttl) return slot.data;
  if (slot.inflight) return slot.inflight;
  slot.inflight = (async () => {
    try {
      const data = await loader();
      slot.data = data; slot.at = Date.now();
      return data;
    } catch (e) {
      if (slot.data) return slot.data; // stale-on-error, caller sees meta via lastSyncAt
      throw e;
    } finally { slot.inflight = null; }
  })();
  return slot.inflight;
}
function lastSyncAt(key) { return cache[key] && cache[key].at ? new Date(cache[key].at).toISOString() : null; }
function clearCache() { Object.keys(cache).forEach((k) => delete cache[k]); }

// ── pure mappers (exported for unit tests) ───────────────────────────────────
const dollarsToCents = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);

function mapEquipment(row, type) {
  return {
    id: `dt_${type}_${row.id}`,
    external_id: String(row.id),
    type,
    unit_number: row.unit_number || null,
    vin: row.vin || '',
    make: row.make || '',
    model: row.model || '',
    year: row.year || null,
    license_plate: row.plate_number || '',
    jurisdiction: row.state || '',
    fuel_type: '',
    registered_weight: null,
    operated_by: (type === 'truck' ? row.assigned_driver && row.assigned_driver.full_name : row.driver_operator && row.driver_operator.full_name) || null,
    status: String(row.status || 'unknown').toLowerCase(),
    eld_provider: null,
    conflict: false,
    source: 'datatruck',
  };
}

function mapDriver(row) {
  const name = (row.account && row.account.full_name) || '';
  return {
    id: `dt_drv_${row.id}`,
    external_id: String(row.id),
    display_name: name,
    position: row.driver_type === 'company_owner' ? 'owner_operator' : 'company_driver',
    truck_unit: (row.assigned_truck && (row.assigned_truck.unit_number || row.assigned_truck)) || null,
    trailer_unit: (row.assigned_trailer && (row.assigned_trailer.unit_number || row.assigned_trailer)) || null,
    phone_e164: row.contact_number || null,
    email: (row.account && row.account.email) || null,
    dispatcher_name: (row.assigned_dispatcher && (row.assigned_dispatcher.full_name || row.assigned_dispatcher)) || null,
    status: String(row.employee_status || row.status || 'active').toLowerCase().includes('active') ? 'active' : 'inactive',
    hire_date: row.hire_date || null,
    source: 'datatruck',
  };
}

function orderToLoad(o) {
  const trip = o.trip || {};
  const D = require('./domain');
  const miles = o.total_miles || trip.mile || null;
  const hauling = dollarsToCents(o.load_pay != null ? o.load_pay : o.total_pay);
  return {
    id: `dt_order_${o.id}`,
    external_id: String(o.id),
    load_number: o.load_id != null ? String(o.load_id) : (o.shipment_id != null ? String(o.shipment_id) : String(o.id)),
    trip_number: trip.trip_id != null ? String(trip.trip_id) : null,
    status: mapOrderStatus(o.status || trip.status),
    raw_status: o.status || trip.status || null,
    driver_name: trip.driver__full_name || null,
    team_driver_name: trip.team_driver__full_name || null,
    dispatcher_name: o.dispatcher__full_name || null,
    broker_name: o.customer__company_name || null,
    mc_name: o.mc_number__company_name || null,
    truck_unit: normalizeUnit(trip.truck__unit_number),
    trailer_unit: null,
    origin_label: stopLabel(o, 'pickup') || (trip.pickup && trip.pickup.location && cityState(trip.pickup.location)) || null,
    destination_label: stopLabel(o, 'delivery') || (trip.delivery && trip.delivery.location && cityState(trip.delivery.location)) || null,
    shipper_name: null,
    receiver_name: null,
    hauling_rate: hauling,
    total_pay: dollarsToCents(o.total_pay),
    assigned_rate: null, // driver settlement not exposed on the order list
    rate_savings: null,
    rpm: (typeof o.per_mile_revenue === 'number' && Number.isFinite(o.per_mile_revenue))
      ? Math.round(o.per_mile_revenue * 100) / 100
      : (hauling != null && miles ? D.rpm(hauling, miles) : null),
    planned_distance_miles: miles,
    pickup_window_start: o.pickup_time || o.pickup_appointment_time || null,
    delivery_window_start: o.delivery_time || o.delivery_appointment_time || null,
    paperwork_state: null,
    pinned: false,
    eta: null,
    previous_eta: null,
    location: null,
    eld_state: null,
    source: 'datatruck',
  };
}
// Canonical status vocabulary lives in the centralized normalizer. Unknown
// DataTruck statuses fall back to 'dispatched' (treated as the driver's current
// load) to preserve historic behavior.
function mapOrderStatus(raw) {
  return require('./statusNormalizer').normalizeLoadStatus(raw, { fallback: 'dispatched' });
}
function normalizeUnit(v) {
  if (v == null) return null;
  const m = String(v).match(/\d+/);
  return m ? m[0].replace(/^0+(?=\d)/, '') : String(v);
}
function cityState(loc) {
  const parts = [loc.city, loc.state].filter(Boolean);
  return parts.length ? parts.join(', ') : (loc.company || null);
}
function stopLabel(o, kind) {
  const stops = Array.isArray(o.stops) ? o.stops : [];
  const stop = stops.find((s) => String(s.stop_type || '').toLowerCase().includes(kind === 'pickup' ? 'pick' : 'del'))
    || (kind === 'pickup' ? stops[0] : stops[stops.length - 1]);
  if (!stop) return null;
  const loc = stop.location || stop;
  return cityState(loc);
}

// ── public read API ──────────────────────────────────────────────────────────
async function getTrucks() {
  return cached('trucks', TTL.trucks, async () => (await fetchPaged('trucks/list/')).map((r) => mapEquipment(r, 'truck')));
}
async function getTrailers() {
  return cached('trailers', TTL.trailers, async () => (await fetchPaged('trailers/list/')).map((r) => mapEquipment(r, 'trailer')));
}
async function getDriversFull() {
  return cached('drivers', TTL.drivers, async () => (await fetchPaged('drivers/list/')).map(mapDriver));
}
async function getRecentOrders() {
  return cached('orders', TTL.orders, async () => {
    const start = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 19);
    const end = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 19);
    const filter = JSON.stringify([{ column: 'pickup_time', value: `${start},${end}`, contains: 'between_datetime' }]);
    const rows = await fetchPaged('orders/', { filter, ordering: '-pickup_time' });
    return rows.map(orderToLoad);
  });
}
// Refresh for the sync layer. Returns per-source counts.
async function refreshAll() {
  clearCache();
  const [trucks, trailers, drivers, orders] = await Promise.all([
    getTrucks(), getTrailers(), getDriversFull(), getRecentOrders(),
  ]);
  return { trucks: trucks.length, trailers: trailers.length, drivers: drivers.length, orders: orders.length };
}

module.exports = {
  isConfigured, getTrucks, getTrailers, getDriversFull, getRecentOrders, refreshAll,
  lastSyncAt, clearCache,
  // pure mappers for tests
  mapEquipment, mapDriver, orderToLoad, mapOrderStatus, normalizeUnit,
};
