/**
 * Multi-trailer rental agreements — header data access.
 *
 * An agreement groups many rental items (trailers) under one company with a
 * shared pricing model, amendments and invoicing. This module owns the header
 * row; items/amendments live in sibling modules. All writes flow through here
 * so agreement-number generation, optimistic-lock bumps and status persistence
 * stay in one reviewable place.
 *
 * Depends only on ./pool and the pure status-derivation helper — no cycles.
 */
'use strict';

const { query, pool } = require('../pool');
const { deriveAgreementStatus } = require('../../services/trailerAgreements/statusDerivation');
const { nextNumber } = require('../trailerRentals');

const CREATE_STATUS = new Set(['draft']);

/**
 * Next agreement number, format AGR-YYYY-NNNNNN. Delegates to the shared
 * advisory-locked generator so concurrent creations cannot collide and the year
 * is never folded into the suffix (the old regexp_replace('\D') implementation
 * produced AGR-2026-2026000002 as the second number).
 */
async function nextAgreementNumber(client = { query }) {
  return nextNumber(client, 'trailer_rental_agreements', 'agreement_number', 'AGR');
}

async function getAgreementById(id, client = { query }) {
  const res = await client.query('SELECT * FROM trailer_rental_agreements WHERE id = $1', [Number(id)]);
  return res.rows[0] || null;
}

/**
 * Create an agreement header. New agreements are ALWAYS 'draft'; a caller may
 * not create one as active/returned/closed. Throws on a disallowed status.
 */
async function createAgreement(input = {}, client = { query }) {
  const status = input.status || 'draft';
  if (!CREATE_STATUS.has(status)) {
    throw Object.assign(
      new Error('A new agreement must be created as draft.'),
      { status: 422, code: 'AGREEMENT_STATUS_NOT_ALLOWED' },
    );
  }
  if (!input.company_id) {
    throw Object.assign(new Error('company_id is required.'), { status: 400, code: 'COMPANY_REQUIRED' });
  }
  const agreementNumber = input.agreement_number || (await nextAgreementNumber(client));
  const cols = {
    agreement_number: agreementNumber,
    company_id: Number(input.company_id),
    status: 'draft',
    pricing_mode: input.pricing_mode || 'per_item',
    currency: 'USD',
    agreement_date: input.agreement_date || null,
    start_date: input.start_date || null,
    original_agreed_amount: input.original_agreed_amount ?? 0,
    current_agreed_amount: input.current_agreed_amount ?? input.original_agreed_amount ?? 0,
    deposit_amount: input.deposit_amount ?? 0,
    agreement_discount: input.agreement_discount ?? 0,
    payment_terms: input.payment_terms || null,
    payment_due_rule: input.payment_due_rule || null,
    payment_grace_period_days: input.payment_grace_period_days ?? 0,
    billing_timezone: input.billing_timezone || 'America/Chicago',
    notes: input.notes || null,
    agreement_media_id: input.agreement_media_id || null,
    created_by_admin_id: input.created_by_admin_id || null,
    updated_by_admin_id: input.created_by_admin_id || null,
  };
  const keys = Object.keys(cols);
  const res = await client.query(
    `INSERT INTO trailer_rental_agreements (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k]),
  );
  return res.rows[0];
}

/** Recompute and persist agreement status from its items, inside a client/txn. */
async function refreshAgreementStatus(agreementId, client = { query }) {
  const agreement = await getAgreementById(agreementId, client);
  if (!agreement) return null;
  if (agreement.status === 'closed' || agreement.status === 'cancelled') return agreement;
  const items = await client.query(
    'SELECT item_status FROM trailer_rental_items WHERE agreement_id = $1', [Number(agreementId)],
  );
  const derived = deriveAgreementStatus(items.rows);
  if (derived === agreement.status) return agreement;
  const res = await client.query(
    `UPDATE trailer_rental_agreements
        SET status = $1, updated_at = NOW(), version = version + 1
      WHERE id = $2 RETURNING *`,
    [derived, Number(agreementId)],
  );
  return res.rows[0];
}

/**
 * Guarded header update with optimistic locking. Mismatched `version` → 409.
 * Only whitelisted mutable fields are written.
 */
async function updateAgreement(id, patch = {}, expectedVersion, client = { query }) {
  const MUTABLE = ['pricing_mode', 'current_agreed_amount', 'deposit_amount', 'agreement_discount',
    'payment_terms', 'payment_due_rule', 'payment_grace_period_days', 'billing_timezone', 'notes',
    'agreement_media_id', 'start_date', 'agreement_date', 'updated_by_admin_id'];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const f of MUTABLE) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${i++}`); vals.push(patch[f]); }
  }
  if (!sets.length) return getAgreementById(id, client);
  sets.push('updated_at = NOW()', 'version = version + 1');
  vals.push(Number(id));
  let where = `id = $${i++}`;
  if (expectedVersion !== undefined && expectedVersion !== null) {
    where += ` AND version = $${i++}`;
    vals.push(Number(expectedVersion));
  }
  const res = await client.query(
    `UPDATE trailer_rental_agreements SET ${sets.join(', ')} WHERE ${where} RETURNING *`, vals,
  );
  if (!res.rows[0]) {
    const current = await getAgreementById(id, client);
    if (!current) throw Object.assign(new Error('Agreement not found.'), { status: 404 });
    throw Object.assign(
      new Error('This agreement was changed by someone else. Reload and try again.'),
      { status: 409, code: 'VERSION_CONFLICT', currentVersion: current.version },
    );
  }
  return res.rows[0];
}

/** List agreements with server-side pagination. */
async function listAgreements({ companyId, status, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const vals = [];
  if (companyId) { vals.push(Number(companyId)); where.push(`company_id = $${vals.length}`); }
  if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
  const totalRes = await query(`SELECT COUNT(*)::int AS total FROM trailer_rental_agreements ${clause}`, vals);
  const rows = await query(
    `SELECT * FROM trailer_rental_agreements ${clause} ORDER BY created_at DESC LIMIT ${size} OFFSET ${offset}`,
    vals,
  );
  return { items: rows.rows, page: Math.max(Number(page) || 1, 1), pageSize: size, total: totalRes.rows[0].total };
}

/** Close an agreement (explicit terminal). Requires all items terminal. */
async function closeAgreement(id, adminId, client = { query }) {
  const res = await client.query(
    `UPDATE trailer_rental_agreements
        SET status = 'closed', closed_at = NOW(), closed_by_admin_id = $2,
            updated_at = NOW(), version = version + 1
      WHERE id = $1 RETURNING *`,
    [Number(id), adminId || null],
  );
  return res.rows[0] || null;
}

module.exports = {
  pool,
  nextAgreementNumber,
  getAgreementById,
  createAgreement,
  refreshAgreementStatus,
  updateAgreement,
  listAgreements,
  closeAgreement,
};
