/**
 * Planned pickup / drop-off INSTRUCTIONS — not completed actions.
 *
 * An instruction is what someone was told to do; an event is what happened.
 * Nothing here touches trailer_current_status. Idempotent against a re-delivered
 * Telegram message via the partial unique index on
 * (telegram_group_id, source_message_id, unit, action).
 */

const { query } = require('../pool');
const { boundedText: s } = require('../sqlValues');
const { normalizeUnitNumber } = require('../../services/trailerMasterList/normalize');

const PLANNED_ACTIONS = new Set(['pickup', 'dropoff']);
const INSTRUCTION_STATES = new Set(['pending', 'confirmed', 'superseded', 'cancelled']);

/**
 * Record a planned/assigned pickup or drop-off INSTRUCTION. This never touches
 * trailer_current_status — an instruction is not a completed action. Idempotent
 * against a re-delivered Telegram message via the partial unique index on
 * (telegram_group_id, source_message_id, unit, action). Returns { instruction, duplicate }.
 */
async function insertTrailerPendingInstruction(input = {}) {
  const unit = normalizeUnitNumber(input.trailer_unit_number);
  const action = String(input.planned_action || '').toLowerCase();
  if (!unit || !PLANNED_ACTIONS.has(action)) return { instruction: null, duplicate: false };

  const telegramGroupId = input.telegram_group_id != null ? String(input.telegram_group_id) : null;
  const sourceMessageId = input.instruction_source_message_id != null ? Number(input.instruction_source_message_id) : null;

  if (telegramGroupId != null && sourceMessageId != null) {
    const dupe = await query(
      `SELECT * FROM trailer_pending_instructions
        WHERE telegram_group_id = $1 AND instruction_source_message_id = $2
          AND trailer_unit_number = $3 AND planned_action = $4
        LIMIT 1`,
      [telegramGroupId, sourceMessageId, unit, action]
    );
    if (dupe.rows[0]) return { instruction: dupe.rows[0], duplicate: true };
  }

  const res = await query(
    `INSERT INTO trailer_pending_instructions (
       trailer_id, trailer_unit_number, planned_action, planned_location, planned_lat, planned_lng,
       driver_group_id, telegram_group_id, telegram_group_name, instruction_source_message_id,
       reported_by_telegram_user_id, reported_by_username, reported_by_name,
       semantic_intent, semantic_confidence, ai_reason, raw_message_text, instruction_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending')
     ON CONFLICT (telegram_group_id, instruction_source_message_id, trailer_unit_number, planned_action)
       WHERE telegram_group_id IS NOT NULL AND instruction_source_message_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.trailer_id != null ? Number(input.trailer_id) : null,
      unit,
      action,
      s(input.planned_location, 500),
      input.planned_lat != null && Number.isFinite(Number(input.planned_lat)) ? Number(input.planned_lat) : null,
      input.planned_lng != null && Number.isFinite(Number(input.planned_lng)) ? Number(input.planned_lng) : null,
      input.driver_group_id != null ? Number(input.driver_group_id) : null,
      telegramGroupId,
      s(input.telegram_group_name, 300),
      sourceMessageId,
      input.reported_by_telegram_user_id != null ? String(input.reported_by_telegram_user_id) : null,
      s(input.reported_by_username, 200),
      s(input.reported_by_name, 300),
      s(input.semantic_intent, 40),
      input.semantic_confidence != null ? Math.max(0, Math.min(100, Math.round(Number(input.semantic_confidence)))) : null,
      s(input.ai_reason, 500),
      s(input.raw_message_text, 4000),
    ]
  );

  // ON CONFLICT DO NOTHING → re-read the existing row on a race.
  if (!res.rows[0] && telegramGroupId != null && sourceMessageId != null) {
    const again = await query(
      `SELECT * FROM trailer_pending_instructions
        WHERE telegram_group_id = $1 AND instruction_source_message_id = $2
          AND trailer_unit_number = $3 AND planned_action = $4 LIMIT 1`,
      [telegramGroupId, sourceMessageId, unit, action]
    );
    if (again.rows[0]) return { instruction: again.rows[0], duplicate: true };
  }
  return { instruction: res.rows[0] || null, duplicate: false };
}

/**
 * The most recent still-PENDING instruction for a unit (optionally filtered by
 * action). Used to backfill a later CONFIRMED event's location with the planned
 * destination and to link the two.
 */
async function getLatestPendingInstruction(unitNumber, action = null) {
  const unit = normalizeUnitNumber(unitNumber);
  if (!unit) return null;
  const params = [unit];
  let actionClause = '';
  if (action && PLANNED_ACTIONS.has(String(action))) {
    actionClause = ' AND planned_action = $2';
    params.push(String(action));
  }
  const res = await query(
    `SELECT * FROM trailer_pending_instructions
      WHERE trailer_unit_number = $1 AND instruction_status = 'pending'${actionClause}
      ORDER BY instruction_created_at DESC, id DESC LIMIT 1`,
    params
  );
  return res.rows[0] || null;
}

/** Mark a pending instruction confirmed (a completed event fulfilled it). */
async function markPendingInstructionConfirmed(id, { confirmedEventId = null } = {}) {
  const res = await query(
    `UPDATE trailer_pending_instructions
       SET instruction_status = 'confirmed', confirmed_event_id = $2,
           resolved_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND instruction_status = 'pending' RETURNING *`,
    [Number(id), confirmedEventId != null ? Number(confirmedEventId) : null]
  );
  return res.rows[0] || null;
}

/** Set an instruction's status (superseded / cancelled / confirmed). */
async function setPendingInstructionStatus(id, status) {
  const st = INSTRUCTION_STATES.has(String(status)) ? String(status) : null;
  if (!st) return null;
  const res = await query(
    `UPDATE trailer_pending_instructions
       SET instruction_status = $2,
           resolved_at = CASE WHEN $2 = 'pending' THEN NULL ELSE NOW() END,
           updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [Number(id), st]
  );
  return res.rows[0] || null;
}

/** List pending instructions for the Admin UI. Filters: status, trailer_id, unit. */
async function listPendingInstructions(filters = {}) {
  const where = [];
  const vals = [];
  let i = 1;
  if (filters.status && INSTRUCTION_STATES.has(String(filters.status))) {
    where.push(`instruction_status = $${i++}`); vals.push(String(filters.status));
  } else if (filters.status !== 'all') {
    where.push(`instruction_status = 'pending'`);
  }
  if (filters.trailer_id) { where.push(`trailer_id = $${i++}`); vals.push(Number(filters.trailer_id)); }
  if (filters.unit) { where.push(`trailer_unit_number = $${i++}`); vals.push(normalizeUnitNumber(filters.unit)); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 200));
  const res = await query(
    `SELECT * FROM trailer_pending_instructions ${whereClause}
     ORDER BY instruction_created_at DESC LIMIT ${limit}`,
    vals
  );
  return res.rows;
}


module.exports = {
  insertTrailerPendingInstruction,
  getLatestPendingInstruction,
  markPendingInstructionConfirmed,
  setPendingInstructionStatus,
  listPendingInstructions,
};
