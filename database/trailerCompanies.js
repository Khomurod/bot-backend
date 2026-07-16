'use strict';

const { query, pool } = require('./pool');
const { insertTrailerAudit } = require('./trailerAudit');

function actorMeta(actor) {
  return { adminId: actor?.id, roleKeys: actor?.role_keys || [], ipAddress: actor?.ipAddress };
}

async function listTrailerCompanies({ q, active } = {}) {
  const values = [];
  const where = [];
  if (q) {
    values.push(`%${String(q).trim()}%`);
    where.push(`(c.legal_name ILIKE $${values.length} OR c.display_name ILIKE $${values.length}
      OR c.mc_number ILIKE $${values.length} OR c.dot_number ILIKE $${values.length})`);
  }
  if (active != null) { values.push(Boolean(active)); where.push(`c.active = $${values.length}`); }
  const res = await query(
    `SELECT c.*,COALESCE(r.active_rentals,0)::int AS active_rentals,
       COALESCE(i.total_invoiced,0)::numeric AS total_invoiced,
       COALESCE(p.total_paid,0)::numeric AS total_paid,
       GREATEST(COALESCE(i.total_invoiced,0)-COALESCE(p.total_paid,0),0) AS outstanding_balance
     FROM trailer_renter_companies c
     LEFT JOIN LATERAL (SELECT COUNT(*) active_rentals FROM trailer_rentals
       WHERE company_id=c.id AND status='active') r ON TRUE
     LEFT JOIN LATERAL (SELECT SUM(total_amount) total_invoiced FROM trailer_invoices
       WHERE company_id=c.id AND status<>'voided') i ON TRUE
     LEFT JOIN LATERAL (SELECT SUM(amount) total_paid FROM trailer_payments
       WHERE company_id=c.id AND verification_status IN ('recorded','verified')) p ON TRUE
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.active DESC, lower(c.display_name)`,
    values,
  );
  return res.rows;
}

async function getTrailerCompany(id) {
  const rows = await listTrailerCompanies();
  const company = rows.find((row) => Number(row.id) === Number(id));
  if (!company) return null;
  const [rentals, invoices, payments] = await Promise.all([
    query(`SELECT r.*, t.unit_number FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id WHERE r.company_id=$1 ORDER BY r.created_at DESC`, [id]),
    query(`SELECT * FROM trailer_invoices WHERE company_id=$1 ORDER BY created_at DESC`, [id]),
    query(`SELECT * FROM trailer_payments WHERE company_id=$1 ORDER BY payment_at DESC`, [id]),
  ]);
  return { ...company, rentals: rentals.rows, invoices: invoices.rows, payments: payments.rows };
}

function companyParams(data) {
  if (!String(data.legal_name || '').trim() || !String(data.display_name || '').trim()) {
    throw Object.assign(new Error('Legal name and display name are required.'), { status: 400 });
  }
  if ((data.default_currency || 'USD') !== 'USD') throw Object.assign(new Error('Only USD is supported.'), { status: 400 });
  return [
    String(data.legal_name).trim(), String(data.display_name).trim(), data.mc_number || null,
    data.dot_number || null, data.billing_address || null, data.contact_name || null,
    data.phone || null, data.email || null, String(data.telegram_username || '').replace(/^@/, '') || null,
    data.telegram_user_id || null, data.payment_terms || null, data.default_daily_rate ?? null,
    data.tax_reference || null, data.notes || null,
  ];
}

async function createTrailerCompany(data, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = companyParams(data);
    const res = await client.query(
      `INSERT INTO trailer_renter_companies
       (legal_name,display_name,mc_number,dot_number,billing_address,contact_name,phone,email,
        telegram_username,telegram_user_id,payment_terms,default_daily_rate,tax_reference,notes,
        created_by_admin_id,updated_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
      [...p, actor?.id || null],
    );
    await insertTrailerAudit({ ...actorMeta(actor), action: 'company.create', entityType: 'company', entityId: res.rows[0].id, newValues: res.rows[0] }, client);
    await client.query('COMMIT');
    return res.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function updateTrailerCompany(id, data, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM trailer_renter_companies WHERE id=$1 FOR UPDATE', [id]);
    if (!before.rows[0]) { await client.query('ROLLBACK'); return null; }
    const merged = { ...before.rows[0], ...data };
    const p = companyParams(merged);
    const res = await client.query(
      `UPDATE trailer_renter_companies SET legal_name=$2,display_name=$3,mc_number=$4,dot_number=$5,
       billing_address=$6,contact_name=$7,phone=$8,email=$9,telegram_username=$10,telegram_user_id=$11,
       payment_terms=$12,default_daily_rate=$13,tax_reference=$14,notes=$15,
       active=COALESCE($16,active),updated_by_admin_id=$17,updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, ...p, data.active ?? null, actor?.id || null],
    );
    await insertTrailerAudit({ ...actorMeta(actor), action: data.active === false ? 'company.archive' : 'company.update', entityType: 'company', entityId: id, oldValues: before.rows[0], newValues: res.rows[0], reason: data.reason }, client);
    await client.query('COMMIT');
    return res.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

module.exports = { listTrailerCompanies, getTrailerCompany, createTrailerCompany, updateTrailerCompany };
