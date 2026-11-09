'use strict';

/**
 * The Dispatcher Board ↔ Bitrix24 check: its switch and its question queue
 * (migrations 0088 and 0098). services/boardBitrix/ decides; this writes.
 *
 * ONE QUESTION OUT AT A TIME. `currentQuestion` is what the ask step checks,
 * and the partial unique index `uniq_board_bitrix_one_asked` holds it when a
 * timer pass and a re-check after "done" race: the second `markAsked` gets a
 * unique violation and reads it as "a question is already waiting".
 *
 * A PASS IS ONE TRANSACTION (`applyPass`): every difference found is upserted
 * and every difference no longer found is resolved together, so a pass that
 * fails halfway leaves the queue exactly as it was. Only a COMPLETE read of the
 * Board and Bitrix may resolve anything — the caller never calls this after a
 * failed read.
 *
 * A difference that comes back reopens its own row (`times_reopened`), never a
 * second one: the key names the deal, truck or person it is about.
 */
const { query, pool } = require('./pool');

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    key: row.discrepancy_key,
    kind: row.kind,
    priority: row.priority,
    details: row.details || {},
    state: row.state,
    firstSeenAt: row.first_seen_at,
    lastChangedAt: row.last_changed_at,
    askedAt: row.asked_at,
    askCount: row.ask_count,
    questionNoticeId: row.question_notice_id == null ? null : Number(row.question_notice_id),
    snoozedUntil: row.snoozed_until,
    resolvedAt: row.resolved_at,
    resolvedHow: row.resolved_how,
    timesReopened: row.times_reopened,
  };
}

/**
 * The switch. `{ enabled: false }` when the table does not exist yet
 * (migration 0088 not applied); ANY OTHER FAILURE IS THROWN — "could not read
 * the switch" is neither "off" nor "on".
 */
async function getSettings() {
  try {
    const res = await query(
      `SELECT enabled, sync_mode, max_updates_per_pass, schema_mapping,
              schema_fingerprint, schema_source, schema_confidence,
              schema_checked_at, updated_at, updated_by
         FROM board_bitrix_settings WHERE id = 1`
    );
    const row = res.rows[0];
    return {
      enabled: row?.enabled === true,
      syncMode: row?.sync_mode || 'off',
      maxUpdatesPerPass: Number(row?.max_updates_per_pass || 10),
      schemaMapping: row?.schema_mapping || null,
      schemaFingerprint: row?.schema_fingerprint || null,
      schemaSource: row?.schema_source || null,
      schemaConfidence: row?.schema_confidence == null ? null : Number(row.schema_confidence),
      schemaCheckedAt: row?.schema_checked_at || null,
      updatedAt: row?.updated_at || null,
      updatedBy: row?.updated_by || null,
    };
  } catch (err) {
    if (err && err.code === '42P01') return { enabled: false, updatedAt: null, updatedBy: null };
    throw err;
  }
}

async function setSyncSettings({ syncMode, maxUpdatesPerPass }, updatedBy = null) {
  const mode = String(syncMode || '').trim();
  const max = Number(maxUpdatesPerPass);
  const res = await query(
    `UPDATE board_bitrix_settings
        SET sync_mode = $1, max_updates_per_pass = $2,
            updated_at = NOW(), updated_by = $3
      WHERE id = 1 AND ($1 <> 'live' OR enabled = TRUE)
      RETURNING id`,
    [mode, max, updatedBy]
  );
  if (mode === 'live' && !res.rows[0]) {
    const err = new Error('the Board ↔ Bitrix check was switched off before live sync could be saved');
    err.code = 'BOARD_BITRIX_CHECK_OFF';
    throw err;
  }
  return getSettings();
}

/** The last dynamically validated schema, for the card and the next diagnosis. */
async function recordSchema({ mapping, fingerprint, source, confidence }) {
  await query(
    `UPDATE board_bitrix_settings
        SET schema_mapping = $1::jsonb, schema_fingerprint = $2,
            schema_source = $3, schema_confidence = $4,
            schema_checked_at = NOW()
      WHERE id = 1`,
    [JSON.stringify(mapping || {}), fingerprint || null, source || null,
      confidence == null ? null : Math.round(Number(confidence))]
  );
}

/** Record a dry-run proposal once; the same unchanged Board event stays one row. */
async function recordPlannedStageSync(action) {
  const res = await query(
    `INSERT INTO board_bitrix_stage_sync_actions
       (action_key, mode, deal_id, board_status, before_stage_id,
        target_stage_id, state, schema_fingerprint)
     VALUES ($1, 'dry_run', $2, $3, $4, $5, 'planned', $6)
     ON CONFLICT (action_key) DO NOTHING
     RETURNING id`,
    [action.actionKey, action.dealId, action.boardStatus, action.beforeStageId,
      action.targetStageId, action.schemaFingerprint || null]
  );
  return Boolean(res.rows[0]);
}

/**
 * Claim one live transition across every process sharing the database. A failed
 * or abandoned claim may be retried; an applied action never can.
 */
async function claimStageSync(action, { leaseMinutes = 5 } = {}) {
  const res = await query(
    `INSERT INTO board_bitrix_stage_sync_actions
       (action_key, mode, deal_id, board_status, before_stage_id,
        target_stage_id, state, schema_fingerprint, claimed_until)
     VALUES ($1, 'live', $2, $3, $4, $5, 'claimed', $6,
             NOW() + make_interval(mins => $7::int))
     ON CONFLICT (action_key) DO UPDATE SET
       state = 'claimed', attempts = board_bitrix_stage_sync_actions.attempts + 1,
       claimed_until = NOW() + make_interval(mins => $7::int),
       last_error = NULL, updated_at = NOW()
     WHERE board_bitrix_stage_sync_actions.state = 'failed'
        OR (board_bitrix_stage_sync_actions.state = 'claimed'
            AND board_bitrix_stage_sync_actions.claimed_until < NOW())
     RETURNING id`,
    [action.actionKey, action.dealId, action.boardStatus, action.beforeStageId,
      action.targetStageId, action.schemaFingerprint || null,
      Math.max(1, Math.round(Number(leaseMinutes) || 5))]
  );
  return res.rows[0] ? Number(res.rows[0].id) : null;
}

async function finishStageSync(id, state, error = null) {
  const allowed = new Set(['applied', 'already_done', 'failed']);
  const next = allowed.has(state) ? state : 'failed';
  await query(
    `UPDATE board_bitrix_stage_sync_actions
        SET state = $2, last_error = $3, claimed_until = NULL,
            updated_at = NOW(), applied_at = CASE WHEN $2 IN ('applied', 'already_done') THEN NOW() ELSE applied_at END
      WHERE id = $1 AND state = 'claimed'`,
    [Number(id), next, error ? String(error).slice(0, 400) : null]
  );
}

async function recentStageSyncActions(limit = 10) {
  const res = await query(
    `SELECT mode, state, board_status, before_stage_id, target_stage_id,
            last_error, updated_at
       FROM board_bitrix_stage_sync_actions
      ORDER BY updated_at DESC LIMIT $1`,
    [Math.min(25, Math.max(1, Number(limit) || 10))]
  );
  return res.rows.map((r) => ({
    mode: r.mode,
    state: r.state,
    boardStatus: r.board_status,
    beforeStageId: r.before_stage_id,
    targetStageId: r.target_stage_id,
    error: r.last_error,
    updatedAt: r.updated_at,
  }));
}

/**
 * Re-read the exact Board event immediately before a live Bitrix write. The
 * poller may have replaced HOME with READY since the comparison began; that
 * newer fact must win. Millisecond truncation matches node-postgres Date
 * precision without treating a genuinely new event as the old one.
 */
async function confirmBoardStatus({ rowKey, boardStatus, statusChangedAt }) {
  if (!rowKey || !boardStatus || !statusChangedAt) return false;
  const res = await query(
    `SELECT 1
       FROM dispatch_board_rows
      WHERE row_key = $1 AND present = TRUE AND UPPER(status) = UPPER($2)
        AND date_trunc('milliseconds', status_changed_at)
            = date_trunc('milliseconds', $3::timestamptz)
      LIMIT 1`,
    [String(rowKey), String(boardStatus), statusChangedAt]
  );
  return Boolean(res.rows[0]);
}

/** Re-read the kill switch immediately before an external Bitrix mutation. */
async function isLiveSyncEnabled() {
  const res = await query(
    `SELECT 1
       FROM board_bitrix_settings
      WHERE id = 1 AND enabled = TRUE AND sync_mode = 'live'
      LIMIT 1`
  );
  return Boolean(res.rows[0]);
}

async function setEnabled(enabled, updatedBy = null) {
  await query(
    `INSERT INTO board_bitrix_settings (id, enabled, updated_at, updated_by) VALUES (1, $1, NOW(), $2)
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       sync_mode = CASE WHEN EXCLUDED.enabled THEN board_bitrix_settings.sync_mode ELSE 'off' END,
       updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [enabled === true, updatedBy]
  );
  return getSettings();
}

/**
 * Every difference found, in ONE statement. A row whose kind, priority and
 * details are unchanged is not rewritten (the WHERE on DO UPDATE): most passes
 * find what the last one found, and rewriting a hundred identical rows every
 * fifteen minutes is database traffic for nothing. A resolved row that comes
 * back is reopened.
 */
const UPSERT = `
  INSERT INTO board_bitrix_discrepancies (discrepancy_key, kind, priority, details)
  SELECT * FROM UNNEST($1::text[], $2::text[], $3::smallint[], $4::jsonb[])
  ON CONFLICT (discrepancy_key) DO UPDATE SET
    kind = EXCLUDED.kind,
    priority = EXCLUDED.priority,
    details = EXCLUDED.details,
    last_changed_at = NOW(),
    times_reopened = board_bitrix_discrepancies.times_reopened
      + CASE WHEN board_bitrix_discrepancies.state = 'resolved' THEN 1 ELSE 0 END,
    snoozed_until = CASE WHEN board_bitrix_discrepancies.state = 'resolved' THEN NULL
                         ELSE board_bitrix_discrepancies.snoozed_until END,
    resolved_at = CASE WHEN board_bitrix_discrepancies.state = 'resolved' THEN NULL
                       ELSE board_bitrix_discrepancies.resolved_at END,
    resolved_how = CASE WHEN board_bitrix_discrepancies.state = 'resolved' THEN NULL
                        ELSE board_bitrix_discrepancies.resolved_how END,
    state = CASE WHEN board_bitrix_discrepancies.state = 'resolved' THEN 'open'
                 ELSE board_bitrix_discrepancies.state END
  WHERE board_bitrix_discrepancies.state = 'resolved'
     OR board_bitrix_discrepancies.kind IS DISTINCT FROM EXCLUDED.kind
     OR board_bitrix_discrepancies.priority IS DISTINCT FROM EXCLUDED.priority
     OR board_bitrix_discrepancies.details IS DISTINCT FROM EXCLUDED.details`;

/**
 * One complete pass: upsert what was found, resolve what was not.
 *
 * @param {Array<{key:string, kind:string, priority:number}>} found  compare.js discrepancies
 * @param {{ confirmId?: number }} [opts]  the question the owner said "done" to:
 *   resolved as `confirmed`, not `seen_fixed`, if it is gone
 * @returns {Promise<{ opened: string[], reopened: string[], resolved: object[] }>}
 *   keys opened and reopened; resolved rows `{ id, key, askCount,
 *   questionNoticeId, resolvedHow, wasAsked }`
 */
async function applyPass(found, { confirmId = null } = {}) {
  const keys = found.map((d) => d.key);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT discrepancy_key, state FROM board_bitrix_discrepancies
        WHERE discrepancy_key = ANY($1::text[]) FOR UPDATE`,
      [keys]
    );
    const stateBefore = new Map(before.rows.map((r) => [r.discrepancy_key, r.state]));
    if (found.length) {
      await client.query(UPSERT, [
        keys,
        found.map((d) => d.kind),
        found.map((d) => Number(d.priority) || 50),
        found.map((d) => JSON.stringify(d)),
      ]);
    }
    const gone = await client.query(
      `WITH gone AS (
         SELECT id, state AS was FROM board_bitrix_discrepancies
          WHERE state IN ('open', 'asked') AND NOT (discrepancy_key = ANY($1::text[]))
          FOR UPDATE
       )
       UPDATE board_bitrix_discrepancies t
          SET state = 'resolved', resolved_at = NOW(),
              resolved_how = CASE WHEN t.id = $2::bigint THEN 'confirmed' ELSE 'seen_fixed' END
         FROM gone WHERE t.id = gone.id
       RETURNING t.id, t.discrepancy_key, t.ask_count, t.question_notice_id, t.resolved_how, gone.was`,
      [keys, confirmId == null ? null : Number(confirmId)]
    );
    await client.query('COMMIT');
    return {
      opened: keys.filter((k) => !stateBefore.has(k)),
      reopened: keys.filter((k) => stateBefore.get(k) === 'resolved'),
      resolved: gone.rows.map((r) => ({
        id: Number(r.id),
        key: r.discrepancy_key,
        askCount: r.ask_count,
        questionNoticeId: r.question_notice_id == null ? null : Number(r.question_notice_id),
        resolvedHow: r.resolved_how,
        wasAsked: r.was === 'asked',
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getDiscrepancy(id) {
  const res = await query('SELECT * FROM board_bitrix_discrepancies WHERE id = $1', [Number(id)]);
  return mapRow(res.rows[0]);
}

/** The question out now, or null. */
async function currentQuestion() {
  const res = await query(`SELECT * FROM board_bitrix_discrepancies WHERE state = 'asked' LIMIT 1`);
  return mapRow(res.rows[0]);
}

/** The next difference to ask about: most important first, then oldest; skipped ones wait out their day. */
async function nextToAsk() {
  const res = await query(
    `SELECT * FROM board_bitrix_discrepancies
      WHERE state = 'open' AND (snoozed_until IS NULL OR snoozed_until <= NOW())
      ORDER BY priority, first_seen_at, id
      LIMIT 1`
  );
  return mapRow(res.rows[0]);
}

/** How many are open and not snoozed — "N more waiting" in the question. */
async function countWaiting() {
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM board_bitrix_discrepancies
      WHERE state = 'open' AND (snoozed_until IS NULL OR snoozed_until <= NOW())`
  );
  return res.rows[0]?.n || 0;
}

/** open → asked. Only an open row moves; a second asker gets the unique violation. */
async function markAsked(id) {
  const res = await query(
    `UPDATE board_bitrix_discrepancies
        SET state = 'asked', asked_at = NOW(), ask_count = ask_count + 1, last_reply_message_id = NULL
      WHERE id = $1 AND state = 'open' RETURNING *`,
    [Number(id)]
  );
  return mapRow(res.rows[0]);
}

async function setQuestionNotice(id, noticeId) {
  await query('UPDATE board_bitrix_discrepancies SET question_notice_id = $2 WHERE id = $1', [Number(id), noticeId == null ? null : Number(noticeId)]);
}

/**
 * The question out, if it has been out longer than `hours` with no answer:
 * marked asked again now, to be re-posted as a reminder. Null otherwise.
 */
async function bumpStaleQuestion(hours) {
  const res = await query(
    `UPDATE board_bitrix_discrepancies
        SET asked_at = NOW(), ask_count = ask_count + 1, last_reply_message_id = NULL
      WHERE state = 'asked' AND asked_at < NOW() - make_interval(hours => $1::int)
      RETURNING *`,
    [Math.max(1, Number(hours) || 24)]
  );
  return mapRow(res.rows[0]);
}

/** Switched off: the question out goes back in line, to be asked afresh when switched on. */
async function releaseQuestion() {
  await query(`UPDATE board_bitrix_discrepancies SET state = 'open', asked_at = NULL WHERE state = 'asked'`);
}

/** asked → open again, when the question reached nobody. */
async function unmarkAsked(id) {
  await query(
    `UPDATE board_bitrix_discrepancies SET state = 'open', asked_at = NULL, ask_count = GREATEST(ask_count - 1, 0)
      WHERE id = $1 AND state = 'asked'`,
    [Number(id)]
  );
}

/**
 * Claim one reply to the question out now. Null when it is not out any more,
 * or this very Telegram message was already handled (a redelivery).
 */
async function claimReply(id, replyMessageId, telegramUserId) {
  const res = await query(
    `UPDATE board_bitrix_discrepancies
        SET last_reply_message_id = $2, last_reply_by_telegram_id = $3
      WHERE id = $1 AND state = 'asked' AND last_reply_message_id IS DISTINCT FROM $2
      RETURNING *`,
    [Number(id), String(replyMessageId), telegramUserId == null ? null : Number(telegramUserId)]
  );
  return mapRow(res.rows[0]);
}

/** "skip": back in line, not asked again for `hours`. */
async function snooze(id, hours = 24) {
  const res = await query(
    `UPDATE board_bitrix_discrepancies
        SET state = 'open', snoozed_until = NOW() + make_interval(hours => $2::int)
      WHERE id = $1 AND state = 'asked' RETURNING *`,
    [Number(id), Math.max(1, Number(hours) || 24)]
  );
  return mapRow(res.rows[0]);
}

/** Where the question was posted, so a confirmation can hang under it. */
async function questionMessage(noticeId) {
  if (noticeId == null) return null;
  const res = await query(
    'SELECT chat_id, telegram_message_id FROM operational_notifications WHERE id = $1',
    [Number(noticeId)]
  );
  const row = res.rows[0];
  return row && row.chat_id && row.telegram_message_id ? { chatId: row.chat_id, messageId: row.telegram_message_id } : null;
}

/** Counts and the question out now — for Settings → Dispatcher Board. */
async function summarise() {
  const counts = await query(
    `SELECT COUNT(*) FILTER (WHERE state = 'open')::int AS open,
            COUNT(*) FILTER (WHERE state = 'open' AND snoozed_until > NOW())::int AS snoozed,
            COUNT(*) FILTER (WHERE state = 'asked')::int AS asked,
            COUNT(*) FILTER (WHERE state = 'resolved' AND resolved_how = 'confirmed')::int AS confirmed,
            COUNT(*) FILTER (WHERE state = 'resolved' AND resolved_how = 'seen_fixed')::int AS seen_fixed
       FROM board_bitrix_discrepancies`
  );
  const byKind = await query(
    `SELECT kind, COUNT(*)::int AS n FROM board_bitrix_discrepancies
      WHERE state IN ('open', 'asked') GROUP BY kind ORDER BY n DESC, kind`
  );
  return {
    ...(counts.rows[0] || {}),
    byKind: byKind.rows.map((r) => ({ kind: r.kind, count: r.n })),
    current: await currentQuestion(),
  };
}

module.exports = {
  getSettings,
  setEnabled,
  setSyncSettings,
  recordSchema,
  recordPlannedStageSync,
  claimStageSync,
  finishStageSync,
  recentStageSyncActions,
  confirmBoardStatus,
  isLiveSyncEnabled,
  applyPass,
  getDiscrepancy,
  currentQuestion,
  nextToAsk,
  countWaiting,
  markAsked,
  bumpStaleQuestion,
  releaseQuestion,
  setQuestionNotice,
  unmarkAsked,
  claimReply,
  snooze,
  questionMessage,
  summarise,
};
