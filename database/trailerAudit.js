'use strict';

const { query } = require('./pool');

function redact(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(copy)) {
    if (/password|token|secret|service.?role|receipt.?content/i.test(key)) copy[key] = '[REDACTED]';
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

async function listTrailerAudit({ entityType, entityId, limit = 200 }) {
  const values = [];
  const where = [];
  if (entityType) { values.push(entityType); where.push(`entity_type = $${values.length}`); }
  if (entityId) { values.push(String(entityId)); where.push(`entity_id = $${values.length}`); }
  values.push(Math.min(500, Math.max(1, Number(limit) || 200)));
  const res = await query(
    `SELECT l.*, a.username
       FROM trailer_audit_log l LEFT JOIN admins a ON a.id = l.admin_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC LIMIT $${values.length}`,
    values,
  );
  return res.rows;
}

module.exports = { insertTrailerAudit, listTrailerAudit, redact };
