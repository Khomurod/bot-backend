'use strict';

/**
 * The activity log (Monitoring → Logs): every Bitrix write the app made and
 * every automatic attempt it refused or that failed, one row each.
 * docs/architecture/activity-log.md.
 *
 * APPEND-ONLY. `insertEntry` is the only way a row is written; the only
 * UPDATE is retention's name scrub (`scrubOldNames`) and the only DELETE is
 * retention's year (`pruneOld`). Every read is bounded and on an index:
 * `occurred_at`, `(trigger, occurred_at)` or `(target_type, target_id)`.
 */

const { query } = require('./pool');
const { NAME_FIELDS, EVIDENCE_NAME_KEYS } = require('../lib/activityLog/entry');

const PAGE_SIZE = 50;
/** Target types a search by number looks in — the index's leading column. */
const SEARCHABLE_TYPES = ['deal', 'contact', 'lead', 'item'];

/**
 * @param {object} e  lib/activityLog/entry.js's shape
 * @returns {Promise<{id: number}|null>}
 */
async function insertEntry(e) {
  const res = await query(
    `INSERT INTO activity_log
       (occurred_at, system, action, target_type, target_id, target_label, change,
        actor_kind, actor_telegram_id, actor_admin_id, actor_name, trigger, reason,
        evidence, result, error, attempt, correlation_key)
     VALUES (COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6, $7::jsonb,
             $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18)
     RETURNING id`,
    [
      e.occurredAt || null, e.system, e.action, e.targetType || null, e.targetId ?? null, e.targetLabel || null,
      JSON.stringify(e.change || []), e.actorKind || 'unknown', e.actorTelegramId ?? null, e.actorAdminId ?? null,
      e.actorName || null, e.trigger || null, e.reason || null, JSON.stringify(e.evidence || {}),
      e.result, e.error || null, e.attempt ?? null, e.correlationKey || null,
    ]
  );
  return res.rows[0] ? { id: Number(res.rows[0].id) } : null;
}

/** One feature's newest entries (id and result only) — for the failure streak. */
async function recentForTrigger(trigger, limit = 20) {
  const res = await query(
    `SELECT id, result, error, reason FROM activity_log
      WHERE trigger = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT $2`,
    [String(trigger), Math.max(1, Math.min(50, Number(limit) || 20))]
  );
  return res.rows.map((r) => ({
    id: Number(r.id), result: r.result, error: r.error, reason: r.reason,
  }));
}

function mapRow(r) {
  return {
    id: Number(r.id),
    occurredAt: r.occurred_at,
    system: r.system,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    targetLabel: r.target_label,
    change: Array.isArray(r.change) ? r.change : [],
    actorKind: r.actor_kind,
    actorTelegramId: r.actor_telegram_id == null ? null : String(r.actor_telegram_id),
    actorAdminId: r.actor_admin_id,
    actorName: r.actor_name,
    trigger: r.trigger,
    reason: r.reason,
    evidence: r.evidence || {},
    result: r.result,
    error: r.error,
    attempt: r.attempt,
    correlationKey: r.correlation_key,
  };
}

/**
 * A page of entries, newest first. `before` is the cursor of the last row of
 * the previous page (`nextCursor`). A text search is a record number (exact,
 * on the target index) or a name — and a name can only be in an entry younger
 * than the scrub, so a name search never reads further back than that.
 *
 * @param {{from?: string, to?: string, trigger?: string, result?: string,
 *   search?: string, before?: string, nameDays?: number}} filters
 * @returns {Promise<{entries: object[], nextCursor: string|null}>}
 */
async function listEntries({
  from = null, to = null, trigger = null, result = null, search = null, before = null, nameDays = 61,
} = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (from) add('occurred_at >= ?::timestamptz', from);
  if (to) add('occurred_at < ?::timestamptz', to);
  if (trigger) add('trigger = ?', trigger);
  if (result) add('result = ?', result);
  const words = String(search || '').trim();
  if (/^\d{1,18}$/.test(words)) {
    add('target_type = ANY(?::text[])', SEARCHABLE_TYPES);
    add('target_id = ?', words);
  } else if (words) {
    add(`occurred_at > NOW() - (? || ' days')::interval`, String(Math.max(1, Number(nameDays) || 61)));
    add(`target_label ILIKE '%' || ? || '%'`, words.replace(/[%_\\]/g, (c) => `\\${c}`).slice(0, 80));
  }
  const cursor = /^(.+)~(\d+)$/.exec(String(before || ''));
  if (cursor) {
    params.push(cursor[1], cursor[2]);
    where.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }
  params.push(PAGE_SIZE + 1);
  const res = await query(
    `SELECT *, occurred_at::text AS occurred_at_exact FROM activity_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  const rows = res.rows.slice(0, PAGE_SIZE);
  const last = rows[rows.length - 1];
  return {
    entries: rows.map(mapRow),
    nextCursor: res.rows.length > PAGE_SIZE && last ? `${last.occurred_at_exact}~${last.id}` : null,
  };
}

/**
 * Retention, decision (e): after `days` the driver's or candidate's name is
 * taken out — `target_label`, the from → to of a name field, and name keys in
 * `evidence` — and the ids stay. Each row once (`names_scrubbed_at`), at most
 * `batch` rows a pass; the hourly tick catches up.
 */
async function scrubOldNames(days = 60, batch = 2000) {
  const res = await query(
    `UPDATE activity_log a
        SET target_label = NULL,
            change = CASE WHEN jsonb_typeof(a.change) = 'array' THEN COALESCE((
              SELECT jsonb_agg(CASE WHEN upper(c->>'field') = ANY($2::text[])
                                    THEN c || '{"from": null, "to": null}'::jsonb ELSE c END ORDER BY ord)
                FROM jsonb_array_elements(a.change) WITH ORDINALITY AS x(c, ord)), '[]'::jsonb)
              ELSE '[]'::jsonb END,
            evidence = a.evidence - $3::text[],
            names_scrubbed_at = NOW()
      WHERE a.id IN (
        SELECT id FROM activity_log
         WHERE names_scrubbed_at IS NULL
           AND occurred_at < NOW() - ($1 || ' days')::interval
         ORDER BY occurred_at
         LIMIT $4)`,
    [String(days), [...NAME_FIELDS], [...EVIDENCE_NAME_KEYS], Math.max(1, Number(batch) || 2000)]
  );
  return res.rowCount || 0;
}

/** Retention, decision (a): an entry is kept a year. */
async function pruneOld(days = 365) {
  const res = await query(
    `DELETE FROM activity_log WHERE occurred_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return res.rowCount || 0;
}

module.exports = {
  PAGE_SIZE,
  insertEntry,
  recentForTrigger,
  listEntries,
  scrubOldNames,
  pruneOld,
};
