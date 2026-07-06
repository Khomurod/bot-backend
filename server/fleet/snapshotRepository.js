/**
 * FleetView snapshot repository — the database-backed cache that lets FleetView
 * load instantly.
 *
 * A background job (services/fleetviewSyncService) periodically fetches from the
 * live integrations (DataTruck / Samsara / ELD), normalizes the result, and
 * writes it here. FleetView read endpoints then serve from this store instead of
 * blocking on the third-party APIs on every page open.
 *
 * Additive-only and startup-safe, matching realDb.js: all DDL is
 * `IF NOT EXISTS`, columns are nullable/defaulted, and it only ever touches its
 * own `fleet_*` tables on the app's shared pg pool (lazy-required so demo mode
 * and unit tests never open a DB connection).
 *
 *   fleet_snapshots      — one JSONB blob per (tenant, kind): the full dataset a
 *                          section renders (map, loads, board, stats, health…),
 *                          plus freshness/source/error metadata.
 *   fleet_unit_snapshots — one relational row per active driver/unit: the
 *                          current-load view with searchable/filterable columns
 *                          (driver, unit, load, status, is_loaded, dispatcher,
 *                          GPS, ETA…).
 *   fleet_sync_status    — per (tenant, source) integration health: last
 *                          success/failure, status, error summary, duration,
 *                          records processed.
 */

'use strict';

let _pool = null;
let _schemaReady = false;

function pool() {
  if (!_pool) _pool = require('../../database/db').pool;
  return _pool;
}

const SNAPSHOT_DDL = `
CREATE TABLE IF NOT EXISTS fleet_snapshots (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  record_count INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  error_summary TEXT,
  duration_ms INTEGER,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE IF NOT EXISTS fleet_unit_snapshots (
  tenant_id TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  driver_name TEXT,
  truck_unit TEXT,
  load_id TEXT,
  load_number TEXT,
  status TEXT,
  is_loaded BOOLEAN NOT NULL DEFAULT FALSE,
  dispatcher_name TEXT,
  origin_label TEXT,
  destination_label TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  speed_mph DOUBLE PRECISION,
  gps_source TEXT,
  gps_observed_at TIMESTAMPTZ,
  gps_stale BOOLEAN NOT NULL DEFAULT FALSE,
  eta_utc TIMESTAMPTZ,
  eta_timing TEXT,
  source_system TEXT,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, unit_key)
);
CREATE INDEX IF NOT EXISTS idx_fleet_unit_snapshots_tenant ON fleet_unit_snapshots (tenant_id, is_loaded);

CREATE TABLE IF NOT EXISTS fleet_sync_status (
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  error_summary TEXT,
  last_duration_ms INTEGER,
  records_processed INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source)
);
`;

async function ensureSchema() {
  if (_schemaReady) return;
  await pool().query(SNAPSHOT_DDL);
  _schemaReady = true;
}

async function query(text, params) {
  await ensureSchema();
  return pool().query(text, params);
}

// ── snapshots (one JSONB blob per kind) ──────────────────────────────────────
async function writeSnapshot(tenantId, kind, { payload, recordCount = 0, source = null, stale = false, error = null, durationMs = null, generatedAt = null }) {
  const gen = generatedAt || new Date().toISOString();
  await query(
    `INSERT INTO fleet_snapshots (tenant_id, kind, payload, record_count, source, stale, error_summary, duration_ms, generated_at, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (tenant_id, kind) DO UPDATE SET
       payload = $3, record_count = $4, source = $5, stale = $6,
       error_summary = $7, duration_ms = $8, generated_at = $9, last_synced_at = NOW()`,
    [tenantId, kind, JSON.stringify(payload == null ? {} : payload), recordCount, source, stale, error, durationMs, gen],
  );
}

/**
 * Read the latest snapshot for a kind. Returns null when absent or on any DB
 * error (callers fall back to a live build), so a missing cache never breaks a
 * page — it just makes the first load slower until the sync job has run once.
 */
async function readSnapshot(tenantId, kind) {
  try {
    const { rows } = await query(
      'SELECT payload, record_count, source, stale, error_summary, duration_ms, generated_at, last_synced_at FROM fleet_snapshots WHERE tenant_id = $1 AND kind = $2',
      [tenantId, kind],
    );
    if (!rows || !rows.length) return null;
    const r = rows[0];
    const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
    return {
      payload,
      recordCount: r.record_count,
      source: r.source,
      stale: r.stale,
      error: r.error_summary,
      durationMs: r.duration_ms,
      generatedAt: r.generated_at ? new Date(r.generated_at).toISOString() : null,
      lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
    };
  } catch (e) {
    return null;
  }
}

// ── per-unit relational rows (current load per driver/truck) ─────────────────
async function replaceUnitSnapshots(tenantId, units) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fleet_unit_snapshots WHERE tenant_id = $1', [tenantId]);
    for (const u of units) {
      await client.query(
        `INSERT INTO fleet_unit_snapshots (tenant_id, unit_key, driver_name, truck_unit, load_id, load_number,
           status, is_loaded, dispatcher_name, origin_label, destination_label, latitude, longitude, speed_mph,
           gps_source, gps_observed_at, gps_stale, eta_utc, eta_timing, source_system, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())`,
        [
          tenantId, u.unit_key, u.driver_name, u.truck_unit, u.load_id, u.load_number,
          u.status, !!u.is_loaded, u.dispatcher_name, u.origin_label, u.destination_label,
          u.latitude, u.longitude, u.speed_mph, u.gps_source, u.gps_observed_at, !!u.gps_stale,
          u.eta_utc, u.eta_timing, u.source_system,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

async function readUnitSnapshots(tenantId) {
  try {
    const { rows } = await query('SELECT * FROM fleet_unit_snapshots WHERE tenant_id = $1', [tenantId]);
    return rows || [];
  } catch (e) { return []; }
}

// ── per-source integration health ────────────────────────────────────────────
async function recordSyncStatus(tenantId, source, { status, error = null, durationMs = null, records = 0 }) {
  const ok = status === 'success' || status === 'ok';
  await query(
    `INSERT INTO fleet_sync_status (tenant_id, source, status, last_success_at, last_failure_at, error_summary, last_duration_ms, records_processed, updated_at)
     VALUES ($1,$2,$3, CASE WHEN $4 THEN NOW() ELSE NULL END, CASE WHEN $4 THEN NULL ELSE NOW() END, $5, $6, $7, NOW())
     ON CONFLICT (tenant_id, source) DO UPDATE SET
       status = $3,
       last_success_at = CASE WHEN $4 THEN NOW() ELSE fleet_sync_status.last_success_at END,
       last_failure_at = CASE WHEN $4 THEN fleet_sync_status.last_failure_at ELSE NOW() END,
       error_summary = $5, last_duration_ms = $6, records_processed = $7, updated_at = NOW()`,
    [tenantId, source, ok ? 'success' : 'error', ok, error ? String(error).slice(0, 300) : null, durationMs, records],
  );
}

async function readSyncStatus(tenantId) {
  try {
    const { rows } = await query('SELECT * FROM fleet_sync_status WHERE tenant_id = $1 ORDER BY source', [tenantId]);
    return (rows || []).map((r) => ({
      source: r.source,
      status: r.status,
      last_success_at: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
      last_failure_at: r.last_failure_at ? new Date(r.last_failure_at).toISOString() : null,
      error_summary: r.error_summary || null,
      last_duration_ms: r.last_duration_ms,
      records_processed: r.records_processed,
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));
  } catch (e) { return []; }
}

module.exports = {
  ensureSchema, query,
  writeSnapshot, readSnapshot,
  replaceUnitSnapshots, readUnitSnapshots,
  recordSyncStatus, readSyncStatus,
};
