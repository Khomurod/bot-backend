/**
 * FleetView sync service — builds the FleetView operational snapshot from the
 * live integrations and persists it so the UI can read instantly.
 *
 * One run:
 *   1. Force-refreshes the shared live-locations snapshot ONCE (batched Samsara/
 *      ELD fetch). DataTruck orders/equipment honor their own adapter TTL so we
 *      never hammer the ~20 req/min TMS limit.
 *   2. Builds each FleetView dataset via the real provider's builders (map,
 *      boards, loads, drivers, equipment, brokers, stats, integration health).
 *   3. Upserts each dataset into fleet_snapshots, refreshes the relational
 *      per-unit current-load rows, and records per-source integration health.
 *
 * It is read-only toward every external system and fail-soft: a failing dataset
 * is logged and skipped, the previous cached snapshot stays in place, and the
 * run never throws out to the scheduler. The background job (./syncJob) calls
 * runOnce() on an interval; the admin "Sync" button reaches it through
 * realProvider.runSync('fleetview').
 */

'use strict';

const { isReal, REAL_TENANT } = require('./config');

const PER_DATASET_TIMEOUT_MS = 25_000;

function normKey(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Datasets to build+persist each run: [snapshotKind, builderFactory].
function datasets(rp) {
  return [
    ['map', () => rp.buildMap()],
    ['board', () => rp.buildBoard()],
    ['loads', () => rp.buildLoads()],
    ['dispatch_board', () => rp.buildDispatchBoard(null)],
    ['drivers', () => rp.buildDrivers()],
    ['equipment_truck', () => rp.buildEquipment('truck')],
    ['equipment_trailer', () => rp.buildEquipment('trailer')],
    ['brokers', () => rp.buildBrokers()],
    ['stats', () => rp.buildStats()],
    ['health', () => rp.buildHealth()],
  ];
}

// Derive the relational per-unit current-load rows from the enriched loads
// dataset (single "current load" logic — driver, unit, status, GPS, ETA).
function unitRowsFromLoads(loadsPayload, N) {
  const rows = (loadsPayload && loadsPayload.rows) || [];
  const seen = new Set();
  const out = [];
  rows.forEach((l) => {
    const key = `${normKey(l.truck_unit)}|${normKey(l.driver_name)}|${normKey(l.load_number)}` || normKey(l.id);
    if (seen.has(key)) return;
    seen.add(key);
    const loc = l.location || null;
    out.push({
      unit_key: key.slice(0, 200) || `k_${out.length}`,
      driver_name: l.driver_name || null,
      truck_unit: l.truck_unit || null,
      load_id: l.id || null,
      load_number: l.load_number || null,
      status: l.status || null,
      is_loaded: N.isLoaded(l.status),
      dispatcher_name: l.dispatcher_name || null,
      origin_label: l.origin_label || null,
      destination_label: l.destination_label || null,
      latitude: loc ? loc.latitude : null,
      longitude: loc ? loc.longitude : null,
      speed_mph: loc ? loc.speed_mph : null,
      gps_source: loc ? loc.source : null,
      gps_observed_at: loc ? loc.observed_at : null,
      gps_stale: !!(loc && loc.freshness === 'stale'),
      eta_utc: l.eta ? l.eta.eta_utc : null,
      eta_timing: l.eta ? l.eta.timing_state : null,
      source_system: 'datatruck+eld',
    });
  });
  return out;
}

let _running = false;

/**
 * Run one full FleetView snapshot build+persist. Returns a summary. Never
 * throws — integration failures are captured per dataset.
 */
async function runOnce({ force = true, triggeredBy = 'sync-job' } = {}) {
  if (!isReal()) return { skipped: 'not-real-mode' };
  if (_running) return { skipped: 'already-running' };
  _running = true;

  const rp = require('./realProvider');
  const N = require('./statusNormalizer');
  const repo = require('./snapshotRepository');
  const tenant = REAL_TENANT.id;
  const startedAt = Date.now();
  const result = { tenant, datasets: {}, errors: [], totalRecords: 0, triggeredBy };

  // 1) Refresh live GPS once (batched). Failure here is non-fatal — builders
  //    fall back to the last good live-locations snapshot.
  let locationsOk = true; let locationsError = null;
  try {
    const snap = await withTimeout(require('../../services/liveLocationsService').getSnapshot({ force }), PER_DATASET_TIMEOUT_MS, 'live-locations refresh');
    if (snap && Array.isArray(snap.errors) && snap.errors.length) {
      locationsError = snap.errors.map((e) => `${e.provider}:${e.code}`).join(',');
    }
    if (snap && snap.isStale) { locationsOk = !!snap.units; }
  } catch (e) {
    locationsOk = false; locationsError = String(e.message).slice(0, 200);
  }

  // 2) Build + persist each dataset independently.
  let loadsPayload = null;
  let datatruckOk = true; let datatruckError = null;
  for (const [kind, build] of datasets(rp)) {
    const t0 = Date.now();
    try {
      const built = await withTimeout(build(), PER_DATASET_TIMEOUT_MS, `build:${kind}`);
      const m = built.meta || {};
      await repo.writeSnapshot(tenant, kind, {
        payload: built.payload,
        recordCount: built.recordCount || 0,
        source: m.source || null,
        stale: !!m.stale,
        error: m.error || null,
        durationMs: Date.now() - t0,
        generatedAt: m.generatedAt || new Date().toISOString(),
      });
      result.datasets[kind] = { records: built.recordCount || 0, ms: Date.now() - t0, stale: !!m.stale };
      result.totalRecords += built.recordCount || 0;
      if (kind === 'loads') loadsPayload = built.payload;
      if (m.error && /datatruck/i.test(String(m.source || m.error))) { datatruckOk = false; datatruckError = m.error; }
    } catch (e) {
      const msg = String(e.message).slice(0, 200);
      result.datasets[kind] = { error: msg };
      result.errors.push(`${kind}: ${msg}`);
      if (/datatruck|orders/i.test(kind)) { datatruckOk = false; datatruckError = msg; }
    }
  }

  // 3) Relational per-unit current-load rows (searchable/filterable).
  let dbOk = true; let dbError = null;
  try {
    if (loadsPayload) await repo.replaceUnitSnapshots(tenant, unitRowsFromLoads(loadsPayload, N));
  } catch (e) { dbOk = false; dbError = String(e.message).slice(0, 200); result.errors.push(`unit_snapshots: ${dbError}`); }

  // 4) Per-source integration health.
  const dur = Date.now() - startedAt;
  await repo.recordSyncStatus(tenant, 'locations', { status: locationsOk ? 'success' : 'error', error: locationsError, durationMs: dur, records: (result.datasets.map || {}).records || 0 }).catch(() => {});
  await repo.recordSyncStatus(tenant, 'datatruck', { status: datatruckOk ? 'success' : 'error', error: datatruckError, durationMs: dur, records: (result.datasets.loads || {}).records || 0 }).catch(() => {});
  await repo.recordSyncStatus(tenant, 'database', { status: dbOk ? 'success' : 'error', error: dbError, durationMs: dur, records: result.totalRecords }).catch(() => {});

  result.durationMs = dur;
  _running = false;
  return result;
}

function isRunning() { return _running; }

module.exports = { runOnce, isRunning };
