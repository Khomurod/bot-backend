'use strict';

/**
 * What the bot proposed in the recruiting group, and what people answered.
 *
 * A PROPOSAL IS RESERVED BEFORE IT IS SENT. The row is inserted `pending`
 * first — a partial unique index allows one open proposal per conversation —
 * and the Telegram message id is recorded after the send. A send Telegram
 * refused marks the row `unsent`, which frees the conversation for a retry.
 *
 * AN ANSWER IS A CLAIM. A button press moves the row `pending → applying` in
 * one UPDATE; the second person to press finds nothing to claim and is told
 * it was already answered. `applying` goes to `applied`, `stale`, or back to
 * `pending` when Bitrix could not be asked.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

function mapProposal(row) {
  if (!row) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(row.id),
    chatId: row.chat_id,
    rootMessageId: Number(row.root_message_id),
    kind: row.kind,
    status: row.status,
    driverName: row.driver_name || null,
    driverPhone: row.driver_phone || null,
    dealId: num(row.deal_id),
    dealTitle: row.deal_title || null,
    categoryId: row.category_id ?? null,
    fromStageId: row.from_stage_id || null,
    fromStageName: row.from_stage_name || null,
    toStageId: row.to_stage_id,
    toStageName: row.to_stage_name,
    evidence: row.evidence || null,
    recruiterUserId: row.recruiter_user_id === null ? null : String(row.recruiter_user_id),
    recruiterName: row.recruiter_name || null,
    botMessageId: num(row.bot_message_id),
    decidedByName: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
  };
}

/** Every proposal made in a conversation, newest first. */
async function listForRoot(chatId, rootMessageId) {
  const { rows } = await query(
    `SELECT * FROM hiring_stage_proposals
      WHERE chat_id = $1 AND root_message_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 50`,
    [String(chatId), Number(rootMessageId)],
  );
  return rows.map(mapProposal);
}

async function getProposal(id) {
  const { rows } = await query('SELECT * FROM hiring_stage_proposals WHERE id = $1', [Number(id)]);
  return mapProposal(rows[0]);
}

/**
 * Reserve a proposal. @returns the row, or null when the conversation already
 * has an open one (the unique index said so).
 */
async function reserveProposal(p) {
  const { rows } = await query(
    `INSERT INTO hiring_stage_proposals (
       chat_id, root_message_id, kind, driver_name, driver_phone, deal_id, deal_title,
       category_id, from_stage_id, from_stage_name, to_stage_id, to_stage_name, evidence,
       recruiter_user_id, recruiter_name
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (chat_id, root_message_id) WHERE status IN ('pending', 'applying') DO NOTHING
     RETURNING *`,
    [
      String(p.chatId), Number(p.rootMessageId), p.kind, p.driverName ?? null, p.driverPhone ?? null,
      p.dealId ?? null, p.dealTitle ?? null, p.categoryId ?? null, p.fromStageId ?? null,
      p.fromStageName ?? null, p.toStageId, p.toStageName, p.evidence ?? null,
      p.recruiterUserId ?? null, p.recruiterName ?? null,
    ],
  );
  return mapProposal(rows[0]);
}

async function recordSent(id, botMessageId) {
  await query(
    'UPDATE hiring_stage_proposals SET bot_message_id = $2, updated_at = NOW() WHERE id = $1',
    [Number(id), Number(botMessageId)],
  );
}

/**
 * Move a proposal from one status to another, only if it is still in `from`.
 * @returns the updated row, or null when somebody else got there first
 */
async function transition(id, from, to, extra = {}) {
  const { rows } = await query(
    `UPDATE hiring_stage_proposals
        SET status = $3,
            decided_by_user_id = COALESCE($4, decided_by_user_id),
            decided_by_name = COALESCE($5, decided_by_name),
            decided_at = CASE WHEN $3 IN ('applied', 'declined', 'stale') THEN NOW() ELSE decided_at END,
            last_error = $6,
            updated_at = NOW()
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING *`,
    [
      Number(id), [].concat(from), to, extra.userId ?? null, extra.userName ?? null, extra.error ?? null,
    ],
  );
  return mapProposal(rows[0]);
}

/**
 * A "create the deal" request whose deal now exists becomes a move proposal,
 * in place: the same message is edited to carry the Move / No buttons.
 */
async function attachDeal(id, deal) {
  const { rows } = await query(
    `UPDATE hiring_stage_proposals
        SET kind = 'move', status = 'pending', deal_id = $2, deal_title = $3, category_id = $4,
            from_stage_id = $5, from_stage_name = $6, to_stage_id = $7, to_stage_name = $8,
            last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'applying'
      RETURNING *`,
    [
      Number(id), deal.dealId, deal.dealTitle, deal.categoryId, deal.fromStageId,
      deal.fromStageName, deal.toStageId, deal.toStageName,
    ],
  );
  return mapProposal(rows[0]);
}

async function listRecentProposals(limit = 30) {
  try {
    const { rows } = await query(
      'SELECT * FROM hiring_stage_proposals ORDER BY updated_at DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 30, 1), 100)],
    );
    return rows.map(mapProposal);
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

/**
 * Proposals carry a driver's name and phone: kept as long as the captured
 * messages they came from (sixty days), then deleted. Open ones are kept.
 */
async function purgeOldProposals(days = 60) {
  try {
    const result = await query(
      `DELETE FROM hiring_stage_proposals
        WHERE created_at < NOW() - make_interval(days => $1)
          AND status NOT IN ('pending', 'applying')`,
      [Number(days)],
    );
    return result.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    throw err;
  }
}

module.exports = {
  purgeOldProposals,
  listForRoot,
  getProposal,
  reserveProposal,
  recordSent,
  transition,
  attachDeal,
  listRecentProposals,
};
