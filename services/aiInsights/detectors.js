/**
 * AI Insights DETECTORS — deterministic pattern finding, no AI.
 *
 * Each detector answers one question about the window (unacknowledged asks,
 * complaint hotspots, pending home-time requests, drivers who went quiet,
 * distribution anomalies) and returns evidence rows. The narration layer only
 * ever words what these produce — it never invents a finding.
 *
 * Split out of services/aiInsightsService.js, which re-exports several of these
 * for its unit tests.
 */
const db = require('../../database/db');
const {
  ACK_WINDOW_MINUTES, SILENT_BASELINE_DAYS, SILENT_MIN_BASELINE_MSGS,
} = require('./constants');
const { excerpt, safeUrlForRow, topEvidence } = require('./senderStats');

// ── Unacknowledged dispatcher messages ─────────────────────────────
function detectUnacked(messages) {
  // For each message whose sender is a dispatcher AND urgency>=2, check
  // if ANY driver message followed in the same group within ACK_WINDOW_MINUTES.
  const byGroup = new Map();
  for (const m of messages) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m);
  }
  const out = [];
  for (const [, groupMsgs] of byGroup) {
    groupMsgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    for (let i = 0; i < groupMsgs.length; i += 1) {
      const m = groupMsgs[i];
      if (m.role !== 'dispatcher' || (Number(m.urgency) || 0) < 2) continue;
      const deadline = new Date(m.created_at).getTime() + ACK_WINDOW_MINUTES * 60 * 1000;
      let acked = false;
      for (let j = i + 1; j < groupMsgs.length; j += 1) {
        if (new Date(groupMsgs[j].created_at).getTime() > deadline) break;
        if (groupMsgs[j].role === 'driver') { acked = true; break; }
      }
      if (!acked) out.push(m);
    }
  }
  return out;
}

// ── Hotspots ───────────────────────────────────────────────────────
function detectHotspots(messages) {
  const hotspotIntents = new Set(['breakdown', 'accident', 'conflict']);
  return messages.filter((m) => hotspotIntents.has(m.intent));
}

// ── Home-time queue ────────────────────────────────────────────────
function detectHomeTimeRequests(buckets) {
  const out = [];
  for (const b of buckets) {
    const reqs = b.messages.filter((m) => m.intent === 'home_time_request');
    if (!reqs.length) continue;
    const entities = reqs
      .map((m) => (m.entities_json || {}))
      .filter((e) => e && (e.home_date || e.city));
    out.push({
      driver_name: b.sender_name,
      driver_telegram_id: b.telegram_user_id,
      group_id: b.group_id,
      group_name: b.group_name,
      role: b.role,
      request_count: reqs.length,
      first_request_at: reqs[0].created_at,
      last_request_at: reqs[reqs.length - 1].created_at,
      days_since_first: Math.max(
        0,
        Math.floor((Date.now() - new Date(reqs[0].created_at).getTime()) / 86400000)
      ),
      extracted_dates: Array.from(new Set(entities.map((e) => e.home_date).filter(Boolean))),
      extracted_cities: Array.from(new Set(entities.map((e) => e.city).filter(Boolean))),
      evidence: topEvidence(reqs, () => true),
    });
  }
  // Drivers only — home-time asks don't come from dispatchers.
  return out
    .filter((r) => r.role === 'driver' || r.role === 'unknown')
    .sort((a, b) => b.days_since_first - a.days_since_first);
}

// ── Silent drivers (have a baseline, went quiet this window) ──────
async function detectSilentDrivers(currentBuckets, daysBack) {
  const baselineDays = Math.max(SILENT_BASELINE_DAYS, daysBack * 4);
  const baseRows = await db.query(
    `SELECT cl.group_id, g.group_name, cl.telegram_user_id, MAX(cl.sender_name) AS sender_name,
            COUNT(*)::INT AS prev_msg_count,
            MAX(cl.created_at) AS last_seen,
            COALESCE(src.role, 'unknown') AS role
       FROM chat_logs cl
       JOIN groups g ON g.id = cl.group_id
       LEFT JOIN sender_role_consensus src
         ON src.group_id = cl.group_id AND src.telegram_user_id = cl.telegram_user_id
      WHERE cl.telegram_user_id IS NOT NULL
        AND g.group_type = 'driver'
        AND cl.created_at >= NOW() - ($1 || ' days')::INTERVAL
        AND cl.created_at <  NOW() - ($2 || ' days')::INTERVAL
      GROUP BY cl.group_id, g.group_name, cl.telegram_user_id, src.role
      HAVING COUNT(*) >= $3`,
    [baselineDays, daysBack, SILENT_MIN_BASELINE_MSGS]
  );

  const activeNow = new Set(currentBuckets.map((b) => `${b.group_id}:${b.telegram_user_id}`));
  return baseRows.rows
    .filter((r) => r.role === 'driver' || r.role === 'unknown')
    .filter((r) => !activeNow.has(`${r.group_id}:${r.telegram_user_id}`))
    .sort((a, b) => b.prev_msg_count - a.prev_msg_count);
}

// ── Anomaly detection (intent-distribution shift vs 30d baseline) ──
function intentDistribution(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const [k, v] of Object.entries(counts)) out[k] = v / total;
  return out;
}

function jsDivergence(p, q) {
  // Jensen-Shannon divergence, base 2, bounded [0..1].
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  let jsd = 0;
  for (const k of keys) {
    const pk = p[k] || 0;
    const qk = q[k] || 0;
    const mk = (pk + qk) / 2;
    if (pk > 0 && mk > 0) jsd += 0.5 * pk * Math.log2(pk / mk);
    if (qk > 0 && mk > 0) jsd += 0.5 * qk * Math.log2(qk / mk);
  }
  return Math.max(0, Math.min(1, jsd));
}

async function detectAnomalies(currentBuckets, daysBack) {
  const baselineDays = Math.max(SILENT_BASELINE_DAYS, daysBack * 4);
  const baseline = await db.query(
    `SELECT cl.group_id, cl.telegram_user_id, a.intent, COUNT(*)::INT AS c
       FROM chat_logs cl
       JOIN chat_message_annotations a ON a.chat_log_id = cl.id
      WHERE cl.created_at >= NOW() - ($1 || ' days')::INTERVAL
        AND cl.created_at <  NOW() - ($2 || ' days')::INTERVAL
        AND cl.telegram_user_id IS NOT NULL
      GROUP BY cl.group_id, cl.telegram_user_id, a.intent`,
    [baselineDays, daysBack]
  );

  const byKey = new Map();
  for (const row of baseline.rows) {
    const key = `${row.group_id}:${row.telegram_user_id}`;
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)[row.intent] = row.c;
  }

  const results = [];
  for (const b of currentBuckets) {
    if (b.role !== 'driver') continue;
    const baseCounts = byKey.get(`${b.group_id}:${b.telegram_user_id}`);
    if (!baseCounts) continue;
    const baseTotal = Object.values(baseCounts).reduce((a, v) => a + v, 0);
    if (baseTotal < 8) continue;
    const jsd = jsDivergence(
      intentDistribution(b.stats.intents),
      intentDistribution(baseCounts)
    );
    if (jsd >= 0.3) {
      results.push({ bucket: b, jsd, baseCounts, currentCounts: b.stats.intents });
    }
  }
  return results.sort((a, b) => b.jsd - a.jsd);
}

// ── Weekly pulse (company-wide numbers) ────────────────────────────
function computePulse(messages, buckets, daysBack) {
  const driverBuckets = buckets.filter((b) => b.role === 'driver');
  const total = messages.length;
  const driverMsgs = driverBuckets.reduce((a, b) => a + b.stats.message_count, 0);
  const neg = messages.filter((m) => (Number(m.sentiment) || 0) <= -1).length;
  const pos = messages.filter((m) => (Number(m.sentiment) || 0) >= 1).length;
  const avgSentiment = total
    ? Number((messages.reduce((a, m) => a + (Number(m.sentiment) || 0), 0) / total).toFixed(2))
    : 0;
  return {
    days_back: daysBack,
    total_messages: total,
    driver_messages: driverMsgs,
    active_drivers: driverBuckets.length,
    negative_messages: neg,
    positive_messages: pos,
    sentiment_avg: avgSentiment,
  };
}

module.exports = {
  detectUnacked,
  detectHotspots,
  detectHomeTimeRequests,
  detectSilentDrivers,
  intentDistribution,
  jsDivergence,
  detectAnomalies,
  computePulse,
};
