/**
 * FleetView real-mode persistence (decision ②a).
 *
 * Additive-only: creates FleetView-owned `fleet_*` tables in the EXISTING
 * Postgres (shared pool from database/db.js). It NEVER creates, alters, drops,
 * or reads the existing operations-hub tables. All DDL is `IF NOT EXISTS` with
 * nullable/defaulted columns, consistent with the repo's startup-safe migration
 * pattern (docs/architecture/module-map.md).
 *
 * The core module (database/db.js) is lazy-required so demo mode and the fleet
 * unit tests never open a DB connection.
 */

'use strict';

let _pool = null;
let _schemaReady = false;

function pool() {
  if (!_pool) {
    // Lazy: only touched in real mode. Reuses the app's single pg.Pool.
    _pool = require('../../database/db').pool;
  }
  return _pool;
}

const FLEET_DDL = `
CREATE TABLE IF NOT EXISTS fleet_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  company_id TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  department_id TEXT,
  creator_id TEXT,
  assignee_id TEXT,
  related_load_id TEXT,
  related_driver_id TEXT,
  related_broker_id TEXT,
  label_ids JSONB DEFAULT '[]',
  due_at TIMESTAMPTZ,
  source TEXT DEFAULT 'manual',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_tasks_tenant ON fleet_tasks (tenant_id, status);

CREATE TABLE IF NOT EXISTS fleet_task_comments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_task_comments_task ON fleet_task_comments (tenant_id, task_id);

CREATE TABLE IF NOT EXISTS fleet_task_activity (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  detail TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet_audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  before JSONB,
  after JSONB,
  reason TEXT,
  correlation_id TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_audit_tenant ON fleet_audit_log (tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS fleet_sync_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  records_fetched INTEGER DEFAULT 0,
  records_created INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  records_skipped INTEGER DEFAULT 0,
  conflicts INTEGER DEFAULT 0,
  error_reason TEXT,
  correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS fleet_sync_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  records_fetched INTEGER DEFAULT 0,
  records_created INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  records_skipped INTEGER DEFAULT 0,
  conflicts INTEGER DEFAULT 0,
  error_reason TEXT,
  correlation_id TEXT,
  triggered_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_fleet_sync_runs_tenant ON fleet_sync_runs (tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS fleet_settings (
  tenant_id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);
`;

async function ensureSchema() {
  if (_schemaReady) return;
  await pool().query(FLEET_DDL);
  _schemaReady = true;
}

async function query(text, params) {
  await ensureSchema();
  return pool().query(text, params);
}

// Persisted audit (real mode). Mirrors the demo audit() contract.
async function insertAudit(row) {
  await query(
    `INSERT INTO fleet_audit_log (id, tenant_id, actor, action, target_type, target_id, before, after, reason, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      `aud_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      row.tenant_id, row.actor, row.action, row.target_type || null, row.target_id || null,
      row.before ? JSON.stringify(row.before) : null,
      row.after ? JSON.stringify(row.after) : null,
      row.reason || null, row.correlation_id || null,
    ],
  );
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ── settings (single row per tenant, JSONB payload) ──────────────────────────
async function getSettings(tenantId) {
  const { rows } = await query('SELECT data, version, updated_at, updated_by FROM fleet_settings WHERE tenant_id = $1', [tenantId]);
  return rows[0] || null;
}
async function putSettings(tenantId, data, version, updatedBy) {
  await query(
    `INSERT INTO fleet_settings (tenant_id, data, version, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (tenant_id) DO UPDATE SET data = $2, version = $3, updated_at = NOW(), updated_by = $4`,
    [tenantId, JSON.stringify(data), version, updatedBy],
  );
}

// ── sync runs ────────────────────────────────────────────────────────────────
async function startSyncRun(tenantId, source, triggeredBy) {
  const id = newId('syn');
  const correlationId = `cid_${Date.now().toString(36)}`;
  await query(
    'INSERT INTO fleet_sync_runs (id, tenant_id, source, status, correlation_id, triggered_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, tenantId, source, 'running', correlationId, triggeredBy],
  );
  return { id, correlationId };
}
async function finishSyncRun(id, { status, fetched = 0, created = 0, updated = 0, skipped = 0, conflicts = 0, error = null }) {
  await query(
    `UPDATE fleet_sync_runs SET status=$2, finished_at=NOW(), records_fetched=$3, records_created=$4,
       records_updated=$5, records_skipped=$6, conflicts=$7, error_reason=$8 WHERE id=$1`,
    [id, status, fetched, created, updated, skipped, conflicts, error],
  );
}
async function listSyncRuns(tenantId, limit = 50) {
  const { rows } = await query(
    'SELECT * FROM fleet_sync_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2',
    [tenantId, limit],
  );
  return rows;
}

module.exports = {
  ensureSchema, query, insertAudit, pool, newId,
  getSettings, putSettings, startSyncRun, finishSyncRun, listSyncRuns,
};
