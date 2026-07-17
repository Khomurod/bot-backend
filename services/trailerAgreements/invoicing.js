/**
 * Agreement invoicing (transactional).
 *
 * Generates invoices for an agreement in two modes:
 *   - combined: one invoice covering every billable item (a bundle line and/or
 *     one rental line per trailer) written to trailer_invoice_lines, with the
 *     legacy trailer_invoices column totals maintained as a denormalized sum so
 *     every existing reader (dashboard, reminders, Telegram) keeps working.
 *   - separate: one invoice per item.
 *
 * Finalized invoice lines are immutable; corrections use adjustments/credits.
 * Line math comes from the pure services/trailerPricing builder.
 */
'use strict';

const { withTxn, httpError } = require('./lifecycle');
const agreementsDb = require('../../database/trailerAgreements/agreements');
const itemsDb = require('../../database/trailerAgreements/items');
const { buildInvoiceLines, buildItemLine } = require('../trailerPricing/invoiceBuilder');
const { insertTrailerAudit } = require('../../database/trailerAudit');

const BILLABLE = new Set(['active', 'returned']);

async function nextInvoiceNumber(client) {
  const res = await client.query(
    `SELECT COALESCE(MAX((regexp_replace(invoice_number, '\\D', '', 'g'))::bigint), 0) + 1 AS n
       FROM trailer_invoices WHERE invoice_number ~ '^INV-'`,
  );
  const year = new Date().getUTCFullYear();
  return `INV-${year}-${String(res.rows[0].n).padStart(6, '0')}`;
}

/** Sum charge columns from a set of lines into the denormalized invoice totals. */
function totalsFromLines(lines) {
  const t = { base: 0, discount: 0, damage: 0, cleaning: 0, late: 0, other: 0, total: 0 };
  for (const l of lines) {
    t.base += Number(l.base_amount || 0);
    t.discount += Number(l.discount_amount || 0);
    t.damage += Number(l.damage_charge || 0);
    t.cleaning += Number(l.cleaning_charge || 0);
    t.late += Number(l.late_fee || 0);
    t.other += Number(l.other_charge || 0);
    t.total += Number(l.line_total || 0);
  }
  return t;
}

async function insertInvoice(client, agreement, item, lines, opts = {}) {
  const t = totalsFromLines(lines);
  const round2 = (n) => Math.round(n * 100) / 100;
  const number = await nextInvoiceNumber(client);
  const periodStart = opts.periodStart
    || (item ? item.actual_pickup_at || item.scheduled_pickup_at : agreement.start_date) || new Date();
  const periodEnd = opts.periodEnd
    || (item ? item.actual_return_at || item.expected_return_at : null) || new Date();
  const dueAt = opts.dueAt || periodEnd;
  const res = await client.query(
    `INSERT INTO trailer_invoices
       (invoice_number, rental_id, trailer_id, company_id, agreement_id, rental_item_id,
        billing_period_start, billing_period_end, billing_method, base_amount,
        discount_amount, damage_charge, cleaning_charge, late_fee, other_charges,
        total_amount, due_at, status, calculation_inputs, created_by_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft',$18,$19)
     RETURNING *`,
    [
      number,
      opts.legacyRentalId || (item ? item.legacy_rental_id : null),
      item ? item.trailer_id : null,
      agreement.company_id,
      agreement.id,
      item ? item.id : null,
      periodStart, periodEnd, 'calendar_day',
      round2(t.base), round2(t.discount), round2(t.damage), round2(t.cleaning),
      round2(t.late), round2(t.other), round2(t.total), dueAt,
      JSON.stringify({ mode: opts.mode || 'combined' }),
      opts.actor?.id || null,
    ],
  );
  const invoice = res.rows[0];
  for (const l of lines) {
    await client.query(
      `INSERT INTO trailer_invoice_lines
         (invoice_id, agreement_id, agreement_item_id, trailer_id, line_type, description,
          quantity, unit, unit_price, base_amount, discount_amount, damage_charge,
          cleaning_charge, late_fee, other_charge, line_total, calculation_inputs,
          service_period_start, service_period_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [invoice.id, agreement.id, l.agreement_item_id, l.trailer_id, l.line_type, l.description,
        l.quantity, l.unit, l.unit_price, l.base_amount, l.discount_amount, l.damage_charge,
        l.cleaning_charge, l.late_fee, l.other_charge, l.line_total,
        JSON.stringify(l.calculation_inputs || {}), l.service_period_start, l.service_period_end],
    );
  }
  return invoice;
}

/** One combined invoice for every billable item on the agreement. */
async function generateCombinedInvoice(agreementId, actor = {}) {
  return withTxn(async (client) => {
    const agreement = await agreementsDb.getAgreementById(agreementId, client);
    if (!agreement) throw httpError('Agreement not found.', 404);
    const items = (await itemsDb.listItems(agreementId, client)).filter((i) => BILLABLE.has(i.item_status));
    if (!items.length) throw httpError('No billable items on this agreement.', 409, 'NOTHING_TO_INVOICE');
    const entries = items.map((item) => ({
      item,
      window: {
        startAt: item.actual_pickup_at || item.scheduled_pickup_at,
        endAt: item.actual_return_at || item.expected_return_at,
        timezone: item.billing_timezone_override || agreement.billing_timezone,
      },
    }));
    const { lines } = buildInvoiceLines(agreement, entries);
    // A combined invoice needs a rental_id (legacy NOT NULL); use the first
    // billable item's legacy id when present, else its own row is agreement-only.
    const invoice = await insertInvoice(client, agreement, null, lines, {
      mode: 'combined', actor, legacyRentalId: items[0].legacy_rental_id,
      periodStart: agreement.start_date, periodEnd: new Date(),
    });
    await insertTrailerAudit({
      adminId: actor.id || null, roleKeys: actor.roleKeys, ipAddress: actor.ip,
      action: 'agreement.invoice.combined', entityType: 'invoice', entityId: invoice.id,
      newValues: { agreement_id: agreement.id, total: invoice.total_amount },
    }, client);
    return { invoice, lineCount: lines.length };
  });
}

/** A separate invoice for a single item. */
async function generateItemInvoice(agreementId, itemId, actor = {}) {
  return withTxn(async (client) => {
    const agreement = await agreementsDb.getAgreementById(agreementId, client);
    if (!agreement) throw httpError('Agreement not found.', 404);
    const item = await itemsDb.getItemById(itemId, client);
    if (!item || Number(item.agreement_id) !== Number(agreementId)) throw httpError('Item not found.', 404);
    if (!BILLABLE.has(item.item_status)) throw httpError('This trailer is not billable yet.', 409);
    const line = buildItemLine(item, {
      startAt: item.actual_pickup_at || item.scheduled_pickup_at,
      endAt: item.actual_return_at || item.expected_return_at,
      timezone: item.billing_timezone_override || agreement.billing_timezone,
    }, {});
    const invoice = await insertInvoice(client, agreement, item, [line], { mode: 'separate', actor });
    await insertTrailerAudit({
      adminId: actor.id || null, roleKeys: actor.roleKeys, ipAddress: actor.ip,
      action: 'agreement.invoice.separate', entityType: 'invoice', entityId: invoice.id,
      newValues: { agreement_id: agreement.id, item_id: item.id, total: invoice.total_amount },
    }, client);
    return { invoice, lineCount: 1 };
  });
}

module.exports = { generateCombinedInvoice, generateItemInvoice, totalsFromLines };
