/**
 * FleetView real-mode data provider.
 *
 * Reuses ONLY the existing read-only services. It must never import an outbound
 * sender (bitrix24Service, ringCentral*, otpService, facebookGraphService) or a
 * scheduler. Everything here is lazy-required so demo mode / unit tests don't
 * pull in the DB or the Samsara/DataTruck chain.
 *
 * Source of truth (decision Phase 3):
 *   - Active units / location / current-load / ETA  → liveLocationsService.getSnapshot()
 *   - Driver roster / dispatcher grouping           → driver_profiles + dispatch_teams
 *   - Rates / brokers / trailers / paperwork        → NOT available from these sources → honest nulls
 *
 * Real mode NEVER returns synthetic data. Anything not wired yet returns an
 * honest empty envelope with source metadata (or a not-connected note).
 */

'use strict';

const D = require('./domain');
const { REAL_TENANT, REAL_COMPANY } = require('./config');

// ── lazy service handles ─────────────────────────────────────────────────────
function liveLocations() { return require('../../services/liveLocationsService'); }
function coreDb() { return require('../../database/db'); }

function meta(extra = {}) {
  return {
    source: 'real', generatedAt: new Date().toISOString(),
    lastSuccessfulSyncAt: null, stale: false, ...extra,
  };
}
function envelope(data, m = {}) {
  return { data, page: 1, pageSize: Array.isArray(data) ? data.length : 1, total: Array.isArray(data) ? data.length : 1, meta: meta(m) };
}
function notConnected(reason) {
  return { data: [], page: 1, pageSize: 0, total: 0, meta: meta({ connected: false, note: reason }) };
}

// ── mapping helpers ──────────────────────────────────────────────────────────
function mapDatatruckStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('deliver')) return 'delivered';
  if (s.includes('transit') || s.includes('enroute') || s.includes('en route')) return 'in_transit';
  if (s.includes('dispatch') || s.includes('assigned') || s.includes('booked')) return 'dispatched';
  if (s.includes('cancel')) return 'canceled';
  return 'dispatched';
}

function timingFromEta(load, etaArrivalIso) {
  // Early/Late computed against DataTruck's delivery window end, when present.
  const windowEnd = load && (load.deliveryWindowEnd || load.deliveryTime);
  if (!windowEnd || !etaArrivalIso) return { state: 'unknown', label: 'Unknown', variance: null };
  const variance = Math.round((new Date(etaArrivalIso).getTime() - new Date(windowEnd).getTime()) / 60000);
  return { state: D.timingState(variance), label: D.timingLabel(variance), variance };
}

// Snapshot unit → FleetView enriched-load row (honest nulls where no source).
function unitToLoad(unit, dispatcherByDriver) {
  const load = unit.load || null;
  const loc = unit.location || null;
  const etaArrival = unit.eta && unit.eta.arrivalTime ? unit.eta.arrivalTime : null;
  const timing = load ? timingFromEta(load, etaArrival) : { state: 'unknown', label: 'Unknown', variance: null };
  const normDriver = String(unit.driverName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    id: `dt_${(load && load.orderId) || unit.unit || normDriver}`,
    load_number: (load && load.loadIdentifier) || null,
    trip_number: null,
    status: load ? mapDatatruckStatus(load.status) : 'dispatched',
    driver_name: unit.driverName || null,
    dispatcher_name: dispatcherByDriver.get(normDriver) || null,
    broker_name: null, // DataTruck does not expose broker as an entity
    truck_unit: unit.unit || null,
    trailer_unit: null,
    origin_label: load ? (load.pickupSummary || load.shipperName || load.pickupAddress || null) : null,
    destination_label: load ? (load.deliverySummary || load.receiverName || load.deliveryAddress || null) : null,
    hauling_rate: null, // rates not available from DataTruck OpenAPI in this project
    assigned_rate: null,
    rate_savings: null,
    rpm: null,
    planned_distance_miles: load ? (load.miles || null) : null,
    paperwork_state: null,
    pinned: false,
    eta: etaArrival ? {
      eta_utc: etaArrival,
      remaining_miles: unit.eta ? unit.eta.distanceMiles : null,
      timing_state: timing.state,
      timing_label: timing.label,
      schedule_variance_minutes: timing.variance,
    } : null,
    previous_eta: null,
    location: loc ? {
      latitude: loc.lat, longitude: loc.lng, speed_mph: loc.speedMph,
      observed_at: loc.lastUpdated, source: unit.provider,
      freshness: loc.isStale ? 'stale' : 'fresh',
    } : null,
    eld_state: {
      connection_state: loc ? 'connected' : 'disconnected',
      stationary: !!(loc && (loc.speedMph == null || loc.speedMph < 1)),
      sleep_timer_minutes: 0,
      inspection_state: 'unknown',
    },
  };
}

// ── dispatcher grouping (driver normalized-name → team/dispatcher name) ──
async function loadDispatcherMap() {
  const map = new Map();
  try {
    const { rows } = await coreDb().query(
      `SELECT dt.name AS team, dtd.driver_normalized_name AS nname
         FROM dispatch_team_drivers dtd
         JOIN dispatch_teams dt ON dt.id = dtd.team_id
        WHERE dt.active = TRUE`,
    );
    rows.forEach((r) => { if (r.nname) map.set(String(r.nname).replace(/[^a-z0-9]/g, ''), r.team); });
  } catch (e) { /* dispatcher grouping optional */ }
  return map;
}

async function snapshot() {
  return liveLocations().getSnapshot({ force: false });
}

// ── wired endpoints ──────────────────────────────────────────────────────────
async function updateBoard(segment, search) {
  let snap;
  try { snap = await snapshot(); } catch (e) {
    return { data: [], page: 1, pageSize: 0, total: 0, meta: meta({ stale: true, error: 'Live locations unavailable', note: 'showing no rows; upstream provider error' }) };
  }
  const dispMap = await loadDispatcherMap();
  let rows = (snap.units || []).map((u) => unitToLoad(u, dispMap));
  if (segment === 'paperwork') rows = []; // no paperwork signal available
  else if (segment === 'stationary') rows = rows.filter((l) => l.eld_state && l.eld_state.stationary);
  else if (segment === 'delayed') rows = rows.filter((l) => l.eta && l.eta.timing_state === 'late');
  else if (segment === 'sleep') rows = [];
  const q = String(search || '').toLowerCase();
  if (q) rows = rows.filter((l) => [l.truck_unit, l.driver_name, l.load_number].some((v) => String(v || '').toLowerCase().includes(q)));
  return { data: rows, page: 1, pageSize: rows.length, total: rows.length, meta: meta({ stale: !!snap.isStale, lastSuccessfulSyncAt: snap.lastSuccessfulRefreshAt || null, source: 'datatruck+eld' }) };
}

async function dispatchMap(condition) {
  let snap;
  try { snap = await snapshot(); } catch (e) {
    return { data: { markers: [], noLocation: [] }, meta: meta({ stale: true, error: 'Live locations unavailable' }) };
  }
  const dispMap = await loadDispatcherMap();
  const rows = (snap.units || []).map((u) => unitToLoad(u, dispMap));
  const withLoc = rows.filter((l) => l.location);
  const noLoc = rows.filter((l) => !l.location).map((l) => ({ load_id: l.id, driver_name: l.driver_name, unit: l.truck_unit, reason: 'Location unavailable' }));
  let markers = withLoc.map((l) => ({
    load_id: l.id, driver_name: l.driver_name, unit: l.truck_unit, load_number: l.load_number,
    status: l.status, latitude: l.location.latitude, longitude: l.location.longitude,
    speed_mph: l.location.speed_mph, observed_at: l.location.observed_at, source: l.location.source,
    freshness: l.location.freshness, remaining_miles: l.eta ? l.eta.remaining_miles : null,
    eta_label: l.eta ? l.eta.timing_label : null,
    condition: l.location.freshness === 'stale' ? 'stale' : (l.load_number ? 'loaded' : 'empty'),
  }));
  if (condition && condition !== 'all') markers = markers.filter((m) => m.condition === condition);
  return { data: { markers, noLocation: noLoc }, meta: meta({ stale: !!snap.isStale, source: 'samsara/eld', lastSuccessfulSyncAt: snap.lastSuccessfulRefreshAt || null }) };
}

async function loadsList({ status, search }) {
  const snap = await snapshot().catch(() => null);
  if (!snap) return { data: [], page: 1, pageSize: 0, total: 0, meta: meta({ stale: true, error: 'Loads source unavailable' }) };
  const dispMap = await loadDispatcherMap();
  let rows = (snap.units || []).filter((u) => u.load).map((u) => unitToLoad(u, dispMap));
  if (status && status !== 'all') rows = rows.filter((l) => l.status === status);
  const q = String(search || '').toLowerCase();
  if (q) rows = rows.filter((l) => [l.load_number, l.driver_name].some((v) => String(v || '').toLowerCase().includes(q)));
  return { data: rows, page: 1, pageSize: rows.length, total: rows.length, meta: meta({ stale: !!snap.isStale, source: 'datatruck', lastSuccessfulSyncAt: snap.lastSuccessfulRefreshAt || null }) };
}

async function loadsKpis() {
  const snap = await snapshot().catch(() => null);
  if (!snap) return { delayed: 0, exceptions: 0, inTransit: 0, delivered: 0, meta: meta({ stale: true }) };
  const rows = (snap.units || []).map((u) => unitToLoad(u, new Map()));
  return {
    delayed: rows.filter((l) => l.eta && l.eta.timing_state === 'late').length,
    exceptions: rows.filter((l) => l.location && l.location.freshness === 'stale').length,
    inTransit: rows.filter((l) => l.status === 'in_transit').length,
    delivered: 0, // no delivered-history source in real mode yet
  };
}

async function drivers({ search }) {
  let rows;
  try {
    const res = await coreDb().query(
      `SELECT dp.first_name, dp.last_name, dp.driver_type, dp.status, dp.unit_number, g.group_name
         FROM driver_profiles dp JOIN groups g ON g.id = dp.group_id
        WHERE dp.status = 'active' ORDER BY dp.last_name NULLS LAST, dp.first_name NULLS LAST`,
    );
    rows = res.rows;
  } catch (e) {
    return { data: [], page: 1, pageSize: 0, total: 0, meta: meta({ error: 'Driver roster unavailable', stale: true }) };
  }
  const dispMap = await loadDispatcherMap();
  let out = rows.map((r, i) => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.group_name || 'Driver';
    const nname = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return {
      id: `drv_${i}_${nname}`,
      display_name: name,
      position: r.driver_type === 'owner' ? 'owner_operator' : 'company_driver',
      truck_unit: r.unit_number || null,
      phone_e164: null, email: null,
      dispatcher_name: dispMap.get(nname) || null,
      hired_company_name: REAL_COMPANY.name,
      status: r.status === 'active' ? 'active' : 'inactive',
    };
  });
  const q = String(search || '').toLowerCase();
  if (q) out = out.filter((d) => d.display_name.toLowerCase().includes(q) || String(d.truck_unit || '').toLowerCase().includes(q));
  return { data: out, page: 1, pageSize: out.length, total: out.length, meta: meta({ source: 'driver_profiles' }) };
}

async function dashboardLoads({ segment, search }) {
  const status = segment === 'dispatched' ? 'dispatched' : segment === 'in_transit' ? 'in_transit' : 'all';
  return loadsList({ status, search });
}

module.exports = {
  envelope, notConnected, meta,
  updateBoard, dispatchMap, loadsList, loadsKpis, drivers, dashboardLoads,
  // exposed for unit tests
  unitToLoad, mapDatatruckStatus, timingFromEta,
};
