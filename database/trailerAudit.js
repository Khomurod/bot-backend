'use strict';

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

async function insertTrailerAudit(entry, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO trailer_audit_log
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

async function listTrailerAudit({ entityType, entityId, limit = 200, page, page_size: pageSize } = {}) {
  const values = [];
  const where = [];
  if (entityType) { values.push(entityType); where.push(`entity_type = $${values.length}`); }
  if (entityId) { values.push(String(entityId)); where.push(`entity_id = $${values.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const select = `SELECT l.*, a.username
       FROM trailer_audit_log l LEFT JOIN admins a ON a.id = l.admin_id
      ${clause}
      ORDER BY l.created_at DESC`;
  // With a page requested, answer the shared paginated envelope; without one,
  // keep the legacy bounded-array behaviour for existing consumers.
  if (page) {
    const p = Math.max(Number(page) || 1, 1);
    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
    const total = await query(`SELECT COUNT(*)::int AS total FROM trailer_audit_log l ${clause}`, values);
    const res = await query(`${select} LIMIT ${size} OFFSET ${(p - 1) * size}`, values);
    return { items: res.rows, page: p, page_size: size, total: total.rows[0].total };
  }
  values.push(Math.min(500, Math.max(1, Number(limit) || 200)));
  const res = await query(`${select} LIMIT $${values.length}`, values);
  return res.rows;
}

module.exports = { insertTrailerAudit, listTrailerAudit, redact };
