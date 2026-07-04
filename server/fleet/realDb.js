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

module.exports = { ensureSchema, query, insertAudit, pool };
