/**
 * Unmatched Telegram trailer mentions — data access.
 *
 * When Telegram names a unit number that matches no active official trailer and
 * no valid alias, the system records the evidence HERE instead of creating a
 * trailer. Turning a mention into a trailer is a separate, explicit, manual,
 * permission-gated action (see reconciliation.js / the routes layer).
 *
 * Depends only on ./pool and pure helpers.
 */
'use strict';

const { query } = require('../pool');
const { normalizeUnitNumber, suggestSimilar } = require('../../lib/trailers/normalize');

/**
 * Queue an unmatched mention, preserving the evidence needed to review it.
 *
 * Idempotent per (group, message, unit): re-processing the same Telegram
 * message must not queue a duplicate, so a retry or a replayed update is safe.
 * Returns the existing row unchanged when already queued.
 *
 * @param {object} input detection evidence
 * @param {object} [options]
 * @param {object} [options.client] existing transaction client
 * @returns {Promise<object|null>} the mention row, or null for a blank unit
 */
async function recordUnmatchedMention(input, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const unit = normalizeUnitNumber(input.unit_number ?? input.normalized_unit_number);
  if (!unit) return null;

  // Suggestions are computed once at capture time so the reviewer sees what the
  // system considered. They are a HUMAN AID: nothing may auto-link on them.
  const known = await run(
    `SELECT id, unit_number FROM trailers WHERE active AND master_status = 'active'`,
  );
  const suggestions = suggestSimilar(unit, known.rows);

  const res = await run(
    `INSERT INTO trailer_unmatched_mentions
       (normalized_unit_number, raw_unit_number, telegram_group_id, telegram_group_title,
        telegram_message_id, telegram_message_link, sender_name, sender_username, message_text,
        detected_at, ai_confidence, extracted_action, extracted_location, suggested_trailer_ids,
        raw_ai_result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, NOW()),$11,$12,$13,$14,$15)
     ON CONFLICT (telegram_group_id, telegram_message_id, normalized_unit_number)
       WHERE telegram_group_id IS NOT NULL AND telegram_message_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      unit,
      input.raw_unit_number ?? input.unit_number ?? null,
      input.telegram_group_id != null ? String(input.telegram_group_id) : null,
      input.telegram_group_title || null,
      input.telegram_message_id != null ? Number(input.telegram_message_id) : null,
      input.telegram_message_link || null,
      input.sender_name || null,
      input.sender_username || null,
      input.message_text || null,
      input.detected_at || null,
      input.ai_confidence != null ? Number(input.ai_confidence) : null,
      input.extracted_action || null,
      input.extracted_location || null,
      JSON.stringify(suggestions),
      input.raw_ai_result ? JSON.stringify(input.raw_ai_result) : null,
    ],
  );
  if (res.rows[0]) return res.rows[0];

  // DO NOTHING fired: the mention is already queued. Return it as-is rather
  // than overwriting a reviewer's decision with a replayed message.
  const existing = await run(
    `SELECT * FROM trailer_unmatched_mentions
      WHERE telegram_group_id = $1 AND telegram_message_id = $2 AND normalized_unit_number = $3`,
    [String(input.telegram_group_id), Number(input.telegram_message_id), unit],
  );
  return existing.rows[0] || null;
}

/** Paginated mention queue. Never returns message bodies in bulk unfiltered. */
async function listUnmatchedMentions(filters = {}) {
  const where = [];
  const values = [];
  let i = 1;

  if (filters.review_status) {
    where.push(`review_status = $${i++}`);
    values.push(String(filters.review_status));
  }
  if (filters.q) {
    where.push(`normalized_unit_number LIKE $${i++}`);
    values.push(`%${normalizeUnitNumber(filters.q) || ''}%`);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const pageSize = Math.min(200, Math.max(1, Number(filters.page_size) || 50));
  const page = Math.max(1, Number(filters.page) || 1);

  const [rows, total] = await Promise.all([
    query(
      `SELECT * FROM trailer_unmatched_mentions ${whereClause}
        ORDER BY detected_at DESC, id DESC
        LIMIT $${i++} OFFSET $${i++}`,
      [...values, pageSize, (page - 1) * pageSize],
    ),
    query(`SELECT COUNT(*)::int AS count FROM trailer_unmatched_mentions ${whereClause}`, values),
  ]);

  return { rows: rows.rows, total: total.rows[0].count, page, page_size: pageSize };
}

async function getUnmatchedMention(id, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run('SELECT * FROM trailer_unmatched_mentions WHERE id = $1', [Number(id)]);
  return res.rows[0] || null;
}

/**
 * Resolve a mention. Only records the decision — it deliberately cannot create
 * a trailer; the caller performs creation through the permission-gated
 * master-list path and passes the resulting id in as linked_trailer_id.
 */
async function resolveUnmatchedMention(id, decision, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const allowed = ['linked', 'created', 'ignored', 'false_detection'];
  if (!allowed.includes(decision.review_status)) {
    throw Object.assign(new Error('Choose how the mention was resolved.'), { status: 400 });
  }
  if (decision.review_status === 'linked' && !decision.linked_trailer_id) {
    throw Object.assign(new Error('Linking a mention requires the trailer to link to.'), { status: 400 });
  }

  const res = await run(
    `UPDATE trailer_unmatched_mentions
        SET review_status = $2,
            linked_trailer_id = $3,
            review_note = $4,
            reviewed_by_admin_id = $5,
            reviewed_at = NOW()
      WHERE id = $1 AND review_status = 'pending'
      RETURNING *`,
    [
      Number(id),
      decision.review_status,
      decision.linked_trailer_id ? Number(decision.linked_trailer_id) : null,
      decision.review_note || null,
      options.actor?.id || null,
    ],
  );
  if (!res.rows[0]) {
    throw Object.assign(new Error('This mention was already reviewed.'), { status: 409 });
  }
  return res.rows[0];
}

/** Pending count for the review-queue badge. */
async function countPendingMentions() {
  const res = await query(`SELECT COUNT(*)::int AS count FROM trailer_unmatched_mentions WHERE review_status = 'pending'`);
  return res.rows[0].count;
}

module.exports = {
  recordUnmatchedMention,
  listUnmatchedMentions,
  getUnmatchedMention,
  resolveUnmatchedMention,
  countPendingMentions,
};
