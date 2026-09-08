'use strict';

/**
 * The administrative audit log: who created or changed an admin account, a
 * role, or a role's permissions, and what the values were before and after.
 *
 * Written by database/rbac.js on every `admin.create` / `admin.update` /
 * `role.create` / `role.update`, and by the retired-feature cleanup action.
 *
 * HISTORY: these rows used to live in `trailer_audit_log`, because the RBAC
 * schema shipped inside the Trailer Department's baseline segment. The Trailer
 * Department is gone; the audit trail is not. Migration
 * 0010_admin_audit_log.sql copies every existing row into `admin_audit_log`,
 * so the trail is continuous across the rename.
 *
 * Redaction is the reason this is one module rather than an inline INSERT: an
 * audit entry carries whole before/after row images, and those rows contain
 * password hashes and signed-URL material that must never be persisted here.
 */

const { query } = require('./pool');

// Sensitive key names, redacted anywhere in the payload (recursively). Covers
// passwords, hashes, tokens, secrets, and signed-URL material (a signed URL or
// its query string must never land in the audit log).
const SENSITIVE_KEY = /password|passwd|token|secret|service.?role|receipt.?content|_hash\b|password_hash|signature|signed.?url|\bsig\b|jwt|bearer|authorization|api.?key/i;

function redact(value, depth = 0) {
  if (value == null || typeof value !== 'object') return value ?? null;
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const copy = {};
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) copy[key] = '[REDACTED]';
    else copy[key] = redact(value[key], depth + 1);
  }
  return copy;
}

async function insertAdminAudit(entry, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO admin_audit_log
       (admin_id, role_keys, action, entity_type, entity_id, old_values, new_values, reason, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      entry.adminId || null,
      entry.roleKeys || [],
      entry.action,
      entry.entityType,
      String(entry.entityId),
      redact(entry.oldValues),
      redact(entry.newValues),
      entry.reason || null,
      entry.ipAddress || null,
    ],
  );
  return res.rows[0];
}

module.exports = { insertAdminAudit, redact };
