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
function dtAdapter() { return require('./dataTruckAdapter'); }

const normKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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
    shipper_name: load ? (load.shipperName || null) : null,
    receiver_name: load ? (load.receiverName || null) : null,
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

// Loads = DataTruck orders (±7-day window) enriched with live location/ETA from
// the shared snapshot (matched by truck unit, then driver name). One source of
// truth for every page. Falls back to the snapshot's active loads when the
// orders fetch fails, and reports stale honestly.
// Live layer join is best-effort: never let a slow/unavailable location stack
// block the orders list. Rows simply lack location/ETA when it can't answer.
async function liveRowsBestEffort(ms = 12_000) {
  try {
    return await Promise.race([
      realRows(),
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  } catch (e) { return null; }
}

async function ordersWithLive() {
  const orders = await dtAdapter().getRecentOrders();
  let snapRows = []; let snapMeta = { isStale: false, lastSuccessfulRefreshAt: null };
  const rr = await liveRowsBestEffort();
  if (rr) { snapRows = rr.rows; snapMeta = rr.snap; }
  const byUnit = new Map(snapRows.filter((r) => r.truck_unit).map((r) => [normKey(r.truck_unit), r]));
  const byDriver = new Map(snapRows.filter((r) => r.driver_name).map((r) => [normKey(r.driver_name), r]));
  const joined = orders.map((o) => {
    const live = (o.truck_unit && byUnit.get(normKey(o.truck_unit))) || (o.driver_name && byDriver.get(normKey(o.driver_name))) || null;
    return live ? { ...o, eta: live.eta, location: live.location, eld_state: live.eld_state, trailer_unit: o.trailer_unit || live.trailer_unit } : o;
  });
  return { rows: joined, snapMeta };
}

async function loadsList({ status, search }) {
  let rows; let snapMeta = {};
  try { ({ rows, snapMeta } = await ordersWithLive()); }
  catch (e) {
    // Orders unavailable → fall back to the live snapshot's current loads only.
    const snap = await snapshot().catch(() => null);
    if (!snap) return { data: [], page: 1, pageSize: 0, total: 0, meta: meta({ stale: true, error: 'Loads source unavailable' }) };
    const dispMap = await loadDispatcherMap();
    rows = (snap.units || []).filter((u) => u.load).map((u) => unitToLoad(u, dispMap));
    snapMeta = snap;
  }
  if (status && status !== 'all') rows = rows.filter((l) => l.status === status);
  const q = String(search || '').toLowerCase();
  if (q) rows = rows.filter((l) => [l.load_number, l.driver_name, l.broker_name, l.truck_unit].some((v) => String(v || '').toLowerCase().includes(q)));
  return {
    data: rows, page: 1, pageSize: rows.length, total: rows.length,
    meta: meta({ stale: !!snapMeta.isStale, source: 'datatruck-orders', lastSuccessfulSyncAt: dtAdapter().lastSyncAt('orders') || snapMeta.lastSuccessfulRefreshAt || null }),
  };
}

async function loadsKpis() {
  try {
    const { rows } = await ordersWithLive();
    return {
      delayed: rows.filter((l) => l.eta && l.eta.timing_state === 'late').length,
      exceptions: rows.filter((l) => l.location && l.location.freshness === 'stale').length,
      inTransit: rows.filter((l) => l.status === 'in_transit').length,
      delivered: rows.filter((l) => l.status === 'delivered').length,
    };
  } catch (e) {
    const snap = await snapshot().catch(() => null);
    if (!snap) return { delayed: 0, exceptions: 0, inTransit: 0, delivered: 0, meta: meta({ stale: true }) };
    const rows = (snap.units || []).map((u) => unitToLoad(u, new Map()));
    return {
      delayed: rows.filter((l) => l.eta && l.eta.timing_state === 'late').length,
      exceptions: rows.filter((l) => l.location && l.location.freshness === 'stale').length,
      inTransit: rows.filter((l) => l.status === 'in_transit').length,
      delivered: 0,
    };
  }
}

async function drivers({ search }) {
  // Primary: the DataTruck roster (authoritative dispatcher/truck/trailer
  // assignment + contact). Fallback: the Telegram-derived driver_profiles.
  let out = null; let source = 'datatruck';
  try {
    out = (await dtAdapter().getDriversFull()).map((d) => ({ ...d, hired_company_name: REAL_COMPANY.name }));
  } catch (e) { out = null; }
  if (!out) {
    source = 'driver_profiles';
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
    out = rows.map((r, i) => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.group_name || 'Driver';
      return {
        id: `drv_${i}_${normKey(name)}`,
        display_name: name,
        position: r.driver_type === 'owner' ? 'owner_operator' : 'company_driver',
        truck_unit: r.unit_number || null,
        phone_e164: null, email: null,
        dispatcher_name: dispMap.get(normKey(name)) || null,
        hired_company_name: REAL_COMPANY.name,
        status: r.status === 'active' ? 'active' : 'inactive',
      };
    });
  }
  const q = String(search || '').toLowerCase();
  if (q) out = out.filter((d) => d.display_name.toLowerCase().includes(q) || String(d.truck_unit || '').toLowerCase().includes(q) || String(d.dispatcher_name || '').toLowerCase().includes(q));
  return { data: out, page: 1, pageSize: out.length, total: out.length, meta: meta({ source, lastSuccessfulSyncAt: dtAdapter().lastSyncAt('drivers') }) };
}

async function dashboardLoads({ segment, search }) {
  const status = segment === 'dispatched' ? 'dispatched' : segment === 'in_transit' ? 'in_transit' : 'all';
  return loadsList({ status, search });
}

// Shared: snapshot → mapped rows (single "current load" logic for every page).
async function realRows() {
  const snap = await snapshot();
  const dispMap = await loadDispatcherMap();
  return { snap, rows: (snap.units || []).map((u) => unitToLoad(u, dispMap)), dispMap };
}

async function loadById(id) {
  try {
    let l = null;
    if (String(id).startsWith('dt_order_')) {
      const { rows } = await ordersWithLive();
      l = rows.find((r) => r.id === id) || null;
    }
    if (!l) {
      const { rows } = await realRows();
      l = rows.find((r) => r.id === id) || null;
    }
    if (!l) return null;
    return {
      ...l,
      stops: [
        l.origin_label ? { id: `${id}_pu`, sequence: 1, type: 'pickup', facility_name: l.origin_label, address: l.origin_label, appointment_start: null } : null,
        l.destination_label ? { id: `${id}_do`, sequence: 2, type: 'dropoff', facility_name: l.destination_label, address: l.destination_label, appointment_start: null } : null,
      ].filter(Boolean),
    };
  } catch (e) { return null; }
}

async function search(q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return { loads: [], drivers: [], trucks: [] };
  let rows = [];
  try { rows = (await realRows()).rows; } catch (e) { rows = []; }
  const loads = rows.filter((l) => String(l.load_number || '').toLowerCase().includes(query))
    .slice(0, 6).map((l) => ({ id: l.id, label: l.load_number, context: `${l.origin_label || '?'} → ${l.destination_label || '?'}` }));
  const drvs = rows.filter((l) => String(l.driver_name || '').toLowerCase().includes(query))
    .slice(0, 6).map((l) => ({ id: l.id, label: l.driver_name, context: `Unit ${l.truck_unit || '—'}` }));
  const trucks = rows.filter((l) => String(l.truck_unit || '').toLowerCase().includes(query))
    .slice(0, 6).map((l) => ({ id: l.id, label: `Unit ${l.truck_unit}`, context: l.driver_name || '' }));
  return { loads, drivers: drvs, trucks };
}

// Dispatch Board: DataTruck orders grouped by real dispatcher, with real
// hauling revenue and RPM (load_pay / per_mile_revenue). Driver settlement is
// not exposed by the order list → assigned/savings stay honestly null.
async function dispatchBoard(weekStart) {
  let orders = [];
  try { orders = await dtAdapter().getRecentOrders(); } catch (e) { orders = []; }
  let live = []; let snapMeta = { isStale: false, lastSuccessfulRefreshAt: null };
  const rr = await liveRowsBestEffort();
  if (rr) { live = rr.rows; snapMeta = rr.snap; }
  const liveByDriver = new Map(live.map((r) => [normKey(r.driver_name), r]));
  let roster = [];
  try { roster = (await drivers({})).data; } catch (e) { roster = []; }

  if (!orders.length && !roster.length) {
    return { data: [], weekStart, summary: { enroute: 0, total_hauling: null, total_assigned: null, total_rate_savings: null, avg_rpm: null }, meta: meta({ stale: true, error: 'Dispatch data unavailable' }) };
  }

  const ordersByDriver = new Map();
  orders.forEach((o) => {
    const k = normKey(o.driver_name);
    if (!k) return;
    if (!ordersByDriver.has(k)) ordersByDriver.set(k, []);
    ordersByDriver.get(k).push(o);
  });

  const groups = new Map();
  roster.forEach((d) => {
    const team = d.dispatcher_name || 'Unassigned';
    if (!groups.has(team)) groups.set(team, { team_lead: null, dispatcher: team, drivers: [] });
    const k = normKey(d.display_name);
    const cur = liveByDriver.get(k) || null;
    const myOrders = ordersByDriver.get(k) || [];
    const hauling = myOrders.reduce((s, o) => s + (o.hauling_rate || 0), 0);
    const miles = myOrders.reduce((s, o) => s + (o.planned_distance_miles || 0), 0);
    groups.get(team).drivers.push({
      id: d.id, name: d.display_name, position: d.position,
      unit: d.truck_unit || (cur && cur.truck_unit) || null,
      condition: cur && cur.location ? (cur.eld_state.stationary ? 'Stationary' : 'Healthy') : 'ELD Not Connected',
      loads: myOrders.map((o) => ({
        id: o.id, load_number: o.load_number,
        route: `${o.origin_label || '?'} → ${o.destination_label || '?'}`,
        status: o.status, pickup: o.pickup_window_start, delivery: o.delivery_window_start,
      })),
      stats: {
        hauling: myOrders.length ? hauling : null,
        assigned: null, rate_savings: null,
        rpm: hauling && miles ? D.rpm(hauling, miles) : null,
      },
    });
  });

  const totalHauling = orders.reduce((s, o) => s + (o.hauling_rate || 0), 0);
  const totalMiles = orders.reduce((s, o) => s + (o.planned_distance_miles || 0), 0);
  return {
    data: [...groups.values()],
    weekStart,
    summary: {
      enroute: orders.filter((o) => o.status === 'in_transit').length,
      total_hauling: orders.length ? totalHauling : null,
      total_assigned: null, total_rate_savings: null,
      avg_rpm: totalHauling && totalMiles ? D.rpm(totalHauling, totalMiles) : null,
    },
    meta: meta({ stale: !!snapMeta.isStale, source: 'datatruck-orders', lastSuccessfulSyncAt: dtAdapter().lastSyncAt('orders'), note: 'Hauling/RPM are real TMS figures; driver settlement (assigned rate) is not exposed by the order list.' }),
  };
}

// Equipment: real trucks/trailers from the DataTruck fleet endpoints (VIN,
// plate, make/model/year, status, assigned driver). Live location provider is
// merged onto trucks by unit number. Snapshot-only fallback if orders API fails.
async function equipments({ type, search: q }) {
  let out = null;
  try {
    out = type === 'trailer' ? await dtAdapter().getTrailers() : await dtAdapter().getTrucks();
    if (type !== 'trailer') {
      const rr = await liveRowsBestEffort();
      const live = rr ? rr.rows : [];
      const byUnit = new Map(live.filter((r) => r.truck_unit).map((r) => [normKey(r.truck_unit), r]));
      out = out.map((t) => {
        const l = t.unit_number ? byUnit.get(normKey(t.unit_number)) : null;
        return l ? { ...t, eld_provider: l.location ? l.location.source : null, last_seen_at: l.location ? l.location.observed_at : null, status: l.status === 'in_transit' ? 'in_transit' : t.status } : t;
      });
    }
  } catch (e) {
    if (type === 'trailer') return notConnected('Trailer list unavailable from the TMS right now.');
    // fallback: units visible in the live snapshot only
    let rows = [];
    try { rows = (await realRows()).rows; } catch (e2) { rows = []; }
    out = rows.filter((l) => l.truck_unit).map((l) => ({
      id: `unit_${l.truck_unit}`, type: 'truck', unit_number: l.truck_unit,
      vin: '', make: '', model: '', year: null, license_plate: '', jurisdiction: '',
      fuel_type: '', registered_weight: null, operated_by: l.driver_name || null,
      status: l.status === 'in_transit' ? 'in_transit' : 'assigned',
      eld_provider: l.location ? l.location.source : null, conflict: false,
      last_seen_at: l.location ? l.location.observed_at : null, source: 'snapshot-fallback',
    }));
  }
  out = out.sort((a, b) => String(a.unit_number).localeCompare(String(b.unit_number), undefined, { numeric: true }));
  const s = String(q || '').toLowerCase();
  if (s) out = out.filter((e) => [e.unit_number, e.operated_by, e.vin, e.license_plate].some((v) => String(v || '').toLowerCase().includes(s)));
  return { data: out, page: 1, pageSize: out.length, total: out.length, meta: meta({ source: 'datatruck', lastSuccessfulSyncAt: dtAdapter().lastSyncAt(type === 'trailer' ? 'trailers' : 'trucks') }) };
}

// Brokers/customers: real `customer__company_name` (and carrier MC name) from
// DataTruck orders — actual customer entities, deduped, no fabricated contacts.
async function brokers({ search: q }) {
  let orders = [];
  try { orders = await dtAdapter().getRecentOrders(); } catch (e) { orders = []; }
  const seen = new Map();
  orders.forEach((o) => {
    const name = o.broker_name;
    if (!name) return;
    const key = normKey(name);
    if (!key) return;
    const existing = seen.get(key);
    if (existing) { existing.loads_in_window += 1; return; }
    seen.set(key, {
      id: `cust_${key}`, display_name: name, legal_name: '', mc_number: '',
      email: '', phone_e164: '', address: '', status: 'active',
      loads_in_window: 1, source: 'datatruck order customer',
    });
  });
  let out = [...seen.values()].sort((a, b) => b.loads_in_window - a.loads_in_window);
  const s = String(q || '').toLowerCase();
  if (s) out = out.filter((b) => b.display_name.toLowerCase().includes(s));
  return { data: out, page: 1, pageSize: out.length, total: out.length, meta: meta({ source: 'datatruck', lastSuccessfulSyncAt: dtAdapter().lastSyncAt('orders'), note: 'Customers from orders in the ±7-day window. Contact details are not exposed by the TMS.' }) };
}

// Integration cards: REAL availability of the main app's existing integrations.
// Presence booleans only — no secret values ever leave the backend.
async function integrationsStatus() {
  const cards = [];
  const push = (type, provider, configured, label, note) => cards.push({
    id: `int_${type}`, tenant_id: REAL_TENANT.id, type, provider,
    masked_account_label: label || '', state: configured ? 'connected' : 'disconnected',
    last_health_check_at: null, last_successful_sync_at: null,
    error_message: configured ? null : (note || 'Not configured in the main application'),
  });
  try {
    const adapter = dtAdapter();
    const configured = adapter.isConfigured();
    cards.push({
      id: 'int_tms', tenant_id: REAL_TENANT.id, type: 'tms', provider: 'DataTruck',
      masked_account_label: 'wenze', state: configured ? 'connected' : 'disconnected',
      last_health_check_at: null,
      last_successful_sync_at: adapter.lastSyncAt('orders') || adapter.lastSyncAt('trucks'),
      error_message: configured ? null : 'Not configured in the main application',
    });
  } catch (e) { push('tms', 'DataTruck', false, '', 'Config unavailable'); }
  try {
    const eld = await require('../../database/eldSettings').getEldConfig();
    const any = (eld.samsaraEnabled && (eld.samsaraApiKeys || []).length > 0) || (eld.factorEnabled && !!eld.factorCompanyKey) || (eld.leaderEnabled && !!eld.leaderCompanyKey);
    push('eld', 'Samsara / Factor / Leader ELD', !!any, '');
  } catch (e) { push('eld', 'Samsara / Factor / Leader ELD', false, '', 'ELD settings unavailable'); }
  push('telegram', 'Telegram Bot', !!process.env.BOT_TOKEN, '', 'Managed by the main application');
  push('ringcentral', 'RingCentral (call-log, read-only)', !!process.env.RC_CLIENT_ID, '');
  push('email', 'Email', false, '', 'No email integration is connected');
  return envelope(cards, { note: 'Credentials are managed by the main application; FleetView reads availability only.' });
}

// Reports: require persisted load history / rates, which do not exist yet.
function reportsUnavailable(which) {
  return {
    data: [],
    summary: { dispatcher_count: 0, canceled_load_count: 0, total_gross: 0, dispatchers: 0, drivers: 0, loads: 0, avg_score: 0 },
    targets: null,
    meta: meta({ connected: false, note: `${which} requires persisted load/rate history, which is not yet collected.` }),
  };
}

async function usersList() {
  try {
    const { rows } = await coreDb().query('SELECT id, username, created_at FROM admins ORDER BY username');
    return envelope(rows.map((a) => ({
      id: `admin:${a.username}`, name: a.username, email: a.username, phone_e164: null,
      department: '—', status: 'active', leader_name: null, roles: ['Administrator'],
    })), { source: 'admins', note: 'Users are managed by the main application admin panel.' });
  } catch (e) {
    return notConnected('User directory unavailable');
  }
}

function companiesList() {
  return envelope([{
    id: REAL_COMPANY.id, tenant_id: REAL_TENANT.id, name: REAL_COMPANY.name,
    mc_number: '', phone_e164: '', email: '', timezone_iana: 'America/Chicago',
    address_line1: '', city: '', state: '', postal_code: '', country: 'US', status: 'active',
  }], { note: 'Single-company deployment.' });
}

// Dashboard KPIs/chart from persisted fleet_tasks.
async function taskSummary(tenantId) {
  try {
    const tasks = await require('./realTasks').list(tenantId);
    const today = new Date().toISOString().slice(0, 10);
    return {
      doneTickets: tasks.filter((t) => t.status === 'done').length,
      highPriorityTickets: tasks.filter((t) => t.priority === 'high' && t.status !== 'archived').length,
      unassignedTickets: tasks.filter((t) => !t.assignee_id && t.status !== 'archived').length,
      todaysTickets: tasks.filter((t) => String(t.created_at).slice(0, 10) === today).length,
    };
  } catch (e) {
    return { doneTickets: 0, highPriorityTickets: 0, unassignedTickets: 0, todaysTickets: 0 };
  }
}
async function taskChart(tenantId) {
  let tasks = [];
  try { tasks = await require('./realTasks').list(tenantId); } catch (e) { tasks = []; }
  const depts = ['Fleet', 'Dispatcher', 'Safety', 'HR', 'Accounting'];
  return {
    data: depts.map((dept) => ({
      department: dept,
      todo: tasks.filter((t) => t.department_id === dept && t.status === 'todo').length,
      inProgress: tasks.filter((t) => t.department_id === dept && t.status === 'in_progress').length,
      done: tasks.filter((t) => t.department_id === dept && t.status === 'done').length,
    })),
  };
}

// Manual sync (admin-only, read-first): refreshes the read caches and records a
// fleet_sync_runs row. It never mutates any external system.
async function runSync(tenantId, source, triggeredBy) {
  const realDb = require('./realDb');
  const { id, correlationId } = await realDb.startSyncRun(tenantId, source, triggeredBy);
  try {
    let fetched = 0;
    if (source === 'locations') {
      const snap = await liveLocations().getSnapshot({ force: true });
      fetched = (snap.units || []).length;
    } else if (source === 'drivers') {
      fetched = ((await drivers({})).data || []).length;
    } else if (source === 'datatruck') {
      const counts = await dtAdapter().refreshAll();
      fetched = counts.trucks + counts.trailers + counts.drivers + counts.orders;
    } else {
      throw new Error(`Unknown sync source: ${source}`);
    }
    await realDb.finishSyncRun(id, { status: 'success', fetched });
    return { runId: id, correlationId, status: 'success', records_fetched: fetched };
  } catch (e) {
    await realDb.finishSyncRun(id, { status: 'error', error: String(e.message).slice(0, 300) }).catch(() => {});
    return { runId: id, correlationId, status: 'error', error: String(e.message).slice(0, 300) };
  }
}

const SETTINGS_DEFAULTS = {
  check_in_radius_miles: 0.5,
  eld_inspection_expiration_days: 30,
  detention_threshold_minutes: 120,
  auto_create_detention_task: false,
  stale_location_minutes: 15,
};

module.exports = {
  envelope, notConnected, meta,
  updateBoard, dispatchMap, loadsList, loadsKpis, drivers, dashboardLoads,
  realRows, loadById, search, dispatchBoard, equipments, brokers,
  integrationsStatus, reportsUnavailable, usersList, companiesList,
  taskSummary, taskChart, runSync, SETTINGS_DEFAULTS,
  // exposed for unit tests
  unitToLoad, mapDatatruckStatus, timingFromEta,
};
