/**
 * AI reports (HITL) + AI Insights v2 (role consensus, annotated ranges, cards).
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');

// ─── AI Reports ───
async function saveAiReport(groupId, reportText, reportType = 'driver') {
  const normalizedType = reportType === 'company' ? 'company' : 'driver';
  const res = await query(
    `INSERT INTO ai_reports (group_id, report_text, report_type, status)
     VALUES ($1, $2, $3, 'draft')
     RETURNING *`,
    [groupId, reportText, normalizedType]
  );
  return res.rows[0];
}

async function getPendingAiReports(type = 'driver') {
  const normalizedType = type === 'company' ? 'company' : 'driver';
  const res = await query(
    `SELECT ar.*, COALESCE(g.group_name, 'Global Driver Groups') AS group_name
     FROM ai_reports ar
     LEFT JOIN groups g ON g.id = ar.group_id
     WHERE ar.status = 'draft'
       AND ar.report_type = $1
     ORDER BY ar.generated_at DESC`
    , [normalizedType]
  );
  return res.rows;
}

/**
 * Every report of one type, drafts AND already-sent, newest first.
 *
 * The sibling getPendingAiReports() is the same shape filtered to
 * status='draft'; this is the admin panel's "include sent" view, which is
 * capped because the table is append-only and grows without bound.
 */
async function listRecentAiReportsByType(type = 'driver', limit = 100) {
  const normalizedType = type === 'company' ? 'company' : 'driver';
  const res = await query(
    `SELECT ar.*, COALESCE(g.group_name, 'Global Driver Groups') AS group_name
           FROM ai_reports ar
           LEFT JOIN groups g ON g.id = ar.group_id
           WHERE ar.report_type = $1
           ORDER BY ar.generated_at DESC
           LIMIT 100`,
    [normalizedType]
  );
  return res.rows;
}

/**
 * Reports produced by the AI Insights v2 pipeline, newest first.
 *
 * They are stored in the same ai_reports table as the HITL drafts and are told
 * apart by a marker inside the JSON payload, so the LIKE is the only available
 * discriminator — there is no format column. Kept verbatim from the route it
 * used to live in; changing it would change which reports the panel lists.
 */
async function listInsightsV2Reports(limit = 20) {
  const res = await query(
    `SELECT id, group_id, report_text, report_type, status, generated_at, sent_at
           FROM ai_reports
          WHERE report_type = 'company'
            AND report_text LIKE '%"format":"insights_v2"%'
          ORDER BY generated_at DESC
          LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function getAiReportById(reportId) {
  const res = await query(
    `SELECT ar.*, COALESCE(g.group_name, 'Global Driver Groups') AS group_name
     FROM ai_reports ar
     LEFT JOIN groups g ON g.id = ar.group_id
     WHERE ar.id = $1`,
    [reportId]
  );
  return res.rows[0];
}

async function updateAiReportStatus(reportId, status) {
  const normalized = String(status || '').toLowerCase();
  if (!['draft', 'sent', 'discarded'].includes(normalized)) {
    throw new Error('Invalid ai report status');
  }
  const res = await query(
    `UPDATE ai_reports
     SET status = $1,
         sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END
     WHERE id = $2
     RETURNING *`,
    [normalized, reportId]
  );
  return res.rows[0];
}

async function discardAiReport(reportId) {
  return updateAiReportStatus(reportId, 'discarded');
}

// ─── AI Insights Pipeline v2 ───────────────────────────────────────
// Sender role consensus. Recomputed before each report by aggregating
// the last N days of per-message role guesses into a confident majority.
async function refreshSenderRoleConsensus(daysBack = 30, groupIds = null) {
  const params = [daysBack];
  let groupClause = '';
  if (Array.isArray(groupIds) && groupIds.length > 0) {
    params.push(groupIds);
    groupClause = `AND cl.group_id = ANY($${params.length}::int[])`;
  }
  const sql = `
    WITH scoped AS (
      SELECT cl.group_id,
             cl.telegram_user_id,
             cl.sender_name,
             a.role_guess,
             a.role_confidence
        FROM chat_logs cl
        JOIN chat_message_annotations a ON a.chat_log_id = cl.id
       WHERE cl.created_at >= NOW() - ($1 || ' days')::INTERVAL
         AND cl.telegram_user_id IS NOT NULL
         ${groupClause}
    ),
    majority AS (
      SELECT group_id, telegram_user_id,
             MAX(sender_name)                                   AS sender_name,
             MODE() WITHIN GROUP (ORDER BY role_guess)          AS role,
             COALESCE(AVG(role_confidence)::INT, 0)             AS confidence,
             COUNT(*)::INT                                      AS message_count
        FROM scoped
       GROUP BY group_id, telegram_user_id
    )
    INSERT INTO sender_role_consensus
      (group_id, telegram_user_id, sender_name, role, confidence, message_count, last_updated)
    SELECT group_id, telegram_user_id, sender_name, role, confidence, message_count, NOW()
      FROM majority
    ON CONFLICT (group_id, telegram_user_id) DO UPDATE
      SET sender_name   = EXCLUDED.sender_name,
          role          = EXCLUDED.role,
          confidence    = EXCLUDED.confidence,
          message_count = EXCLUDED.message_count,
          last_updated  = NOW()
  `;
  const res = await query(sql, params);
  return res.rowCount || 0;
}

async function getSenderRoleConsensus(groupIds = null) {
  if (Array.isArray(groupIds) && groupIds.length > 0) {
    const res = await query(
      `SELECT * FROM sender_role_consensus WHERE group_id = ANY($1::int[])`,
      [groupIds]
    );
    return res.rows;
  }
  const res = await query(`SELECT * FROM sender_role_consensus`);
  return res.rows;
}

// Fetch all annotated messages in window. Used by the insights aggregator
// and by the Ask-the-Data narrative fallback. Includes role consensus so
// downstream code has a single source of truth per-sender.
async function getAnnotatedMessagesForRange({ daysBack = 7, groupIds = null, limit = null } = {}) {
  const params = [daysBack];
  let groupClause = '';
  if (Array.isArray(groupIds) && groupIds.length > 0) {
    params.push(groupIds);
    groupClause = `AND v.group_id = ANY($${params.length}::int[])`;
  }
  let limitClause = '';
  if (Number.isInteger(limit) && limit > 0) {
    params.push(limit);
    limitClause = `LIMIT $${params.length}`;
  }
  const res = await query(
    `SELECT v.*
       FROM v_annotated_messages v
      WHERE v.created_at >= NOW() - ($1 || ' days')::INTERVAL
        ${groupClause}
      ORDER BY v.created_at ASC
      ${limitClause}`,
    params
  );
  return res.rows;
}

// ─── AI Insights (per-card) ───────────────────────────────────────
async function createAiInsight(insight) {
  const {
    report_id,
    kind,
    severity = 1,
    rank = 0,
    title,
    narrative_html = null,
    suggested_action = null,
    evidence_json = null,
    metrics_json = null,
    driver_name = null,
    driver_telegram_id = null,
    group_id = null,
  } = insight;
  const res = await query(
    `INSERT INTO ai_insights
      (report_id, kind, severity, rank, title, narrative_html, suggested_action,
       evidence_json, metrics_json, driver_name, driver_telegram_id, group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
     RETURNING *`,
    [
      report_id,
      kind,
      severity,
      rank,
      title,
      narrative_html,
      suggested_action,
      evidence_json ? JSON.stringify(evidence_json) : null,
      metrics_json ? JSON.stringify(metrics_json) : null,
      driver_name,
      driver_telegram_id,
      group_id,
    ]
  );
  return res.rows[0];
}

async function getInsightsForReport(reportId) {
  const res = await query(
    `SELECT * FROM ai_insights
      WHERE report_id = $1
      ORDER BY
        CASE kind
          WHEN 'pulse' THEN 0
          WHEN 'at_risk' THEN 1
          WHEN 'star' THEN 2
          WHEN 'home_time' THEN 3
          WHEN 'unacked' THEN 4
          WHEN 'silent' THEN 5
          WHEN 'anomaly' THEN 6
          WHEN 'hotspot' THEN 7
          WHEN 'one_on_one' THEN 8
          ELSE 9
        END,
        severity DESC,
        rank ASC,
        id ASC`,
    [reportId]
  );
  return res.rows;
}

async function getInsightById(id) {
  const res = await query(`SELECT * FROM ai_insights WHERE id = $1`, [id]);
  return res.rows[0];
}

async function updateInsightStatus(id, status, feedback = null, patch = null) {
  const normalized = String(status || '').toLowerCase();
  if (!['pending', 'approved', 'dismissed', 'edited', 'sent'].includes(normalized)) {
    throw new Error('Invalid insight status');
  }
  const setParts = ['status = $1', 'updated_at = NOW()'];
  const params = [normalized];
  if (feedback !== null && feedback !== undefined) {
    params.push(String(feedback).slice(0, 500));
    setParts.push(`admin_feedback = $${params.length}`);
  }
  if (patch && typeof patch === 'object') {
    if (typeof patch.title === 'string') {
      params.push(patch.title.slice(0, 300));
      setParts.push(`title = $${params.length}`);
    }
    if (typeof patch.narrative_html === 'string') {
      params.push(patch.narrative_html.slice(0, 20000));
      setParts.push(`narrative_html = $${params.length}`);
    }
    if (typeof patch.suggested_action === 'string') {
      params.push(patch.suggested_action.slice(0, 1000));
      setParts.push(`suggested_action = $${params.length}`);
    }
  }
  params.push(id);
  const res = await query(
    `UPDATE ai_insights SET ${setParts.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return res.rows[0];
}

async function deleteInsightsForReport(reportId) {
  const res = await query(`DELETE FROM ai_insights WHERE report_id = $1`, [reportId]);
  return res.rowCount || 0;
}


module.exports = {
  saveAiReport,
  getPendingAiReports,
  listRecentAiReportsByType,
  listInsightsV2Reports,
  getAiReportById,
  updateAiReportStatus,
  discardAiReport,
  refreshSenderRoleConsensus,
  getSenderRoleConsensus,
  getAnnotatedMessagesForRange,
  createAiInsight,
  getInsightsForReport,
  getInsightById,
  updateInsightStatus,
  deleteInsightsForReport,
};
