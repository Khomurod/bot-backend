'use strict';

/**
 * The bot's claim on creating a candidate's Bitrix contact and deal
 * (migration 0100). services/hiringStages/crmCreate.js is the only writer.
 *
 * WHY A CLAIM. Creating is the one Bitrix call that cannot simply be repeated:
 * a second `crm.deal.add` is a second deal. So every step is written HERE
 * BEFORE the Bitrix call it guards —
 *
 *   claimed → creating_contact → creating_deal → created
 *
 * — and a read that finds a row already at `creating_contact` or
 * `creating_deal` knows an earlier call may have reached Bitrix without an
 * answer, and searches Bitrix before it adds anything. One row per
 * conversation; at most one creation in flight per phone (a partial unique
 * index), so two posts of the same driver cannot both create.
 *
 * `blocked` (the identity turned out ambiguous) and `failed` (Bitrix refused)
 * create nothing; a later message in the conversation may try again.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';
const UNIQUE_VIOLATION = '23505';

function mapRecord(row) {
  if (!row) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(row.id),
    chatId: row.chat_id,
    rootMessageId: Number(row.root_message_id),
    phone: row.phone,
    driverName: row.driver_name,
    // What a creation writes to Bitrix (migration 0104); older rows use driverName.
    displayName: row.display_name || null,
    status: row.status,
    contactId: num(row.contact_id),
    contactReused: Boolean(row.contact_reused),
    dealId: num(row.deal_id),
    dealReused: Boolean(row.deal_reused),
    categoryId: row.category_id ?? null,
    stageId: row.stage_id ?? null,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getForRoot(chatId, rootMessageId) {
  const { rows } = await query(
    'SELECT * FROM hiring_stage_crm_records WHERE chat_id = $1 AND root_message_id = $2',
    [String(chatId), Number(rootMessageId)],
  );
  return mapRecord(rows[0]);
}

/**
 * Claim the creation for one conversation.
 * @returns {{record: object}} the claimed row — new, or the conversation's
 *   own earlier one (a `blocked` / `failed` one is claimed afresh)
 *   | {{busy: true}} another conversation is creating for the same phone
 */
async function claim({
  chatId, rootMessageId, phone, driverName, displayName = null,
}) {
  try {
    // The display name is the one the creation started with: a creation in
    // flight keeps it; only a fresh start (after `blocked` / `failed`) takes the new one.
    const { rows } = await query(
      `INSERT INTO hiring_stage_crm_records (chat_id, root_message_id, phone, driver_name, display_name, attempts)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (chat_id, root_message_id) DO UPDATE
          SET status = CASE WHEN hiring_stage_crm_records.status IN ('blocked', 'failed')
                            THEN 'claimed' ELSE hiring_stage_crm_records.status END,
              display_name = CASE WHEN hiring_stage_crm_records.status IN ('blocked', 'failed')
                                  THEN EXCLUDED.display_name
                                  ELSE COALESCE(hiring_stage_crm_records.display_name, EXCLUDED.display_name) END,
              attempts = hiring_stage_crm_records.attempts + 1,
              updated_at = NOW()
       RETURNING *`,
      [String(chatId), Number(rootMessageId), String(phone), String(driverName), displayName ? String(displayName) : null],
    );
    return { record: mapRecord(rows[0]) };
  } catch (err) {
    if (err && err.code === UNIQUE_VIOLATION) return { busy: true };
    throw err;
  }
}

/** Move a record on, only from the status it is known to be in. @returns the row, or null. */
async function advance(id, from, to, fields = {}) {
  const { rows } = await query(
    `UPDATE hiring_stage_crm_records
        SET status = $3,
            contact_id = COALESCE($4, contact_id),
            contact_reused = COALESCE($5, contact_reused),
            deal_id = COALESCE($6, deal_id),
            deal_reused = COALESCE($7, deal_reused),
            category_id = COALESCE($8, category_id),
            stage_id = COALESCE($9, stage_id),
            last_error = $10,
            updated_at = NOW()
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING *`,
    [
      Number(id), [].concat(from), to, fields.contactId ?? null, fields.contactReused ?? null,
      fields.dealId ?? null, fields.dealReused ?? null, fields.categoryId ?? null, fields.stageId ?? null,
      fields.error ?? null,
    ],
  );
  return mapRecord(rows[0]);
}

async function listRecentRecords(limit = 15) {
  try {
    const { rows } = await query(
      'SELECT * FROM hiring_stage_crm_records ORDER BY updated_at DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 15, 1), 100)],
    );
    return rows.map(mapRecord);
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

/** A driver's name and phone: deleted at sixty days, unless a creation is still in flight. */
async function purgeOldRecords(days = 60) {
  try {
    const result = await query(
      `DELETE FROM hiring_stage_crm_records
        WHERE created_at < NOW() - make_interval(days => $1)
          AND status NOT IN ('claimed', 'creating_contact', 'creating_deal')`,
      [Number(days)],
    );
    return result.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    throw err;
  }
}

module.exports = {
  getForRoot, claim, advance, listRecentRecords, purgeOldRecords,
};
