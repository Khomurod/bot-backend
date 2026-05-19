// services/aiInsightsService.js
//
// Stage B + Stage C of the AI Insights pipeline.
//
//   1. Ensure every chat_logs row in scope is annotated (delegates to
//      aiAnnotationService).
//   2. Refresh sender_role_consensus so "who is a driver" is derived
//      from the last 30 days of annotations.
//   3. Aggregate deterministic per-sender stats (NO AI here).
//   4. Detect at-risk / stars / silent / home-time / unacked / hotspots /
//      anomaly / 1:1 recommendations / weekly pulse purely from those
//      annotations + stats.
//   5. For every detection that should ship to management, ask Groq
//      for a short narrative — given the metrics + cited excerpts, not
//      the raw transcript. This keeps context small, cost low, and
//      grounding high.
//
// Nothing in this file relies on Samsara, ELD, HR, or any external
// operational data. Everything comes from chat_logs + its annotations.

const db = require('../database/db');
const { callGroqRaw } = require('./groqClient');
const { ensureAnnotationsForRange } = require('./aiAnnotationService');
const { buildTelegramMessageUrl } = require('./telegramUrl');

const AT_RISK_SCORE_THRESHOLD = 4;
const STAR_SCORE_THRESHOLD = 3;
const SILENT_BASELINE_DAYS = 30;
const SILENT_MIN_BASELINE_MSGS = 5;
const MAX_EVIDENCE_PER_CARD = 5;
const MAX_CARDS_PER_KIND = 5;
const ACK_WINDOW_MINUTES = 30;

// ── Utility ────────────────────────────────────────────────────────
function excerpt(text, n = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function safeUrlForRow(row) {
  return buildTelegramMessageUrl(row.telegram_group_id, row.telegram_message_id) || null;
}

function groupBySender(messages) {
  const by = new Map();
  for (const m of messages) {
    if (!m.telegram_user_id) continue;
    const key = `${m.group_id}:${m.telegram_user_id}`;
    if (!by.has(key)) {
      by.set(key, {
        group_id: m.group_id,
        group_name: m.group_name,
        telegram_user_id: m.telegram_user_id,
        sender_name: m.sender_name,
        role: m.role || m.msg_role_guess || 'unknown',
        messages: [],
      });
    }
    by.get(key).messages.push(m);
  }
  return by;
}

// ── Per-sender statistics (deterministic) ──────────────────────────
function computeSenderStats(senderBucket) {
  const msgs = senderBucket.messages;
  const stats = {
    message_count: msgs.length,
    first_msg_at: msgs[0]?.created_at || null,
    last_msg_at: msgs[msgs.length - 1]?.created_at || null,
    sentiment_avg: 0,
    sentiment_min: 0,
    neg_count: 0,
    pos_count: 0,
    urgency_high: 0,
    ack_count: 0,
    toxic_count: 0,
    intents: {},
  };
  if (!msgs.length) return stats;
  let sSum = 0;
  let sMin = 99;
  for (const m of msgs) {
    const sentiment = Number.isFinite(m.sentiment) ? Number(m.sentiment) : 0;
    sSum += sentiment;
    if (sentiment < sMin) sMin = sentiment;
    if (sentiment <= -1) stats.neg_count += 1;
    if (sentiment >= 1) stats.pos_count += 1;
    if ((Number(m.urgency) || 0) >= 2) stats.urgency_high += 1;
    if (m.is_acknowledgement) stats.ack_count += 1;
    if (m.toxic) stats.toxic_count += 1;
    const intent = m.intent || 'no_signal';
    stats.intents[intent] = (stats.intents[intent] || 0) + 1;
  }
  stats.sentiment_avg = Number((sSum / msgs.length).toFixed(2));
  stats.sentiment_min = sMin === 99 ? 0 : sMin;
  return stats;
}

function computeSenderBucketsWithStats(messages) {
  const by = groupBySender(messages);
  const out = [];
  for (const bucket of by.values()) {
    const stats = computeSenderStats(bucket);
    out.push({ ...bucket, stats });
  }
  return out;
}

// ── Detection rules ────────────────────────────────────────────────
function scoreAtRisk(b) {
  const s = b.stats;
  const intents = s.intents;
  return (
    (intents.quit_signal || 0) * 5 +
    (intents.complaint || 0) * 1.5 +
    (intents.home_time_request || 0) * 0.7 +
    (intents.conflict || 0) * 2 +
    s.neg_count * 1 +
    s.toxic_count * 2 +
    (s.sentiment_min <= -2 ? 2 : 0)
  );
}

function scoreStar(b) {
  const s = b.stats;
  const intents = s.intents;
  return (
    (intents.praise || 0) * 2 +
    s.pos_count * 0.8 +
    (intents.acknowledgement || 0) * 0.15 +
    (s.neg_count === 0 && s.pos_count >= 2 ? 1 : 0) -
    s.neg_count * 0.5 -
    s.toxic_count * 3
  );
}

function topEvidence(messages, predicate, n = MAX_EVIDENCE_PER_CARD) {
  return messages
    .filter(predicate)
    .slice(-n)
    .map((m) => ({
      url: safeUrlForRow(m),
      excerpt: excerpt(m.message_text),
      at: m.created_at,
      intent: m.intent,
      sentiment: m.sentiment,
      urgency: m.urgency,
    }))
    .filter((e) => e.excerpt);
}

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

// ── Narrative generation (Consolidated Groq call for all cards) ──────────
const BATCH_SYSTEM_PROMPT = [
  'You are an executive auditor for a trucking company.',
  'I am providing evidence for several operational categories in a JSON object.',
  'Return a single, valid JSON object where the keys are the exact card IDs provided,',
  'and the values are an object containing keys: narrative_html, suggested_action, severity (1..3).',
  'The narrative_html should be a 1-2 sentence HTML-formatted narrative summarizing the evidence.',
  'Rules:',
  '- Ground every claim in the provided metrics or evidence excerpts.',
  '- Never fabricate facts. If evidence is thin, say "limited signal" explicitly.',
  '- Use plain HTML only: <b>, <i>, <br>. DO NOT output markdown blocks, only raw JSON.',
  '- Include at most 3 inline <a href="..."> links using only URLs present in input.evidence.',
  '- Never include code fences or prose outside the JSON.',
].join('\n');

function buildBatchCardPrompt(cardsContext) {
  return `Cards briefing input:\n${JSON.stringify(cardsContext, null, 2)}`;
}

function parseBatchCardNarratives(text) {
  if (!text) return {};
  const cleaned = String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
      const result = {};
      for (const [key, val] of Object.entries(parsed)) {
        if (val && typeof val === 'object') {
          result[key] = {
             narrative_html: typeof val.narrative_html === 'string'
               ? val.narrative_html.slice(0, 4000)
               : null,
             suggested_action: typeof val.suggested_action === 'string'
               ? val.suggested_action.slice(0, 500)
               : null,
             severity: Number.isFinite(Number(val.severity))
               ? Math.max(1, Math.min(3, Math.round(Number(val.severity))))
               : 1,
          };
        }
      }
      return result;
    }
  } catch (_) { /* fall through */ }
  return {};
}

async function narrateBatch(cardsContext) {
  if (Object.keys(cardsContext).length === 0) return {};
  try {
    const raw = await callGroqRaw(buildBatchCardPrompt(cardsContext), {
      systemText: BATCH_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 3000,
    });
    return parseBatchCardNarratives(raw) || {};
  } catch (err) {
    console.error('[AI-INSIGHTS] Batch Narrative failed:', err.message);
    return {};
  }
}

// ── Orchestrator: produce a full report with cards ─────────────────
async function generateInsightReport({ daysBack = 7, groupIds = null, reportType = 'company', groupIdForReport = null } = {}) {
  console.log(`[AI-INSIGHTS] Generating insight report (type=${reportType}, days=${daysBack})`);

  // 1. Refresh role consensus for these groups
  await db.refreshSenderRoleConsensus(Math.max(30, daysBack * 4), groupIds);

  // 2. Pull annotated messages for the window
  const messages = await db.getAnnotatedMessagesForRange({ daysBack, groupIds });
  if (!messages.length) {
    return {
      report: null,
      cards: [],
      pulse: { days_back: daysBack, total_messages: 0 },
      reason: 'No messages in window',
    };
  }

  // 4. Per-sender aggregation (deterministic, no AI)
  const buckets = computeSenderBucketsWithStats(messages);

  // 5. Deterministic detection
  const atRisk = buckets
    .filter((b) => b.role !== 'admin')
    .map((b) => ({ bucket: b, score: scoreAtRisk(b) }))
    .filter((x) => x.score >= AT_RISK_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CARDS_PER_KIND);

  const stars = buckets
    .filter((b) => b.role !== 'admin')
    .map((b) => ({ bucket: b, score: scoreStar(b) }))
    .filter((x) => x.score >= STAR_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CARDS_PER_KIND);

  const homeTime = detectHomeTimeRequests(buckets).slice(0, MAX_CARDS_PER_KIND);
  const unacked = detectUnacked(messages).slice(-10);
  const hotspots = detectHotspots(messages).slice(-10);
  const silent = await detectSilentDrivers(buckets, daysBack);
  const anomalies = await detectAnomalies(buckets, daysBack);
  const pulse = computePulse(messages, buckets, daysBack);

  const pendingCards = [];

  // At-risk
  for (let i = 0; i < atRisk.length; i += 1) {
    const { bucket, score } = atRisk[i];
    const evidence = topEvidence(
      bucket.messages,
      (m) => ['complaint', 'quit_signal', 'conflict', 'home_time_request'].includes(m.intent) || m.sentiment <= -1
    );
    pendingCards.push({
      id: `at_risk_${i}`,
      dbArgs: {
        kind: 'at_risk',
        rank: i,
        title: `At-risk: ${bucket.sender_name}`,
        evidence_json: evidence,
        metrics_json: {
          score: Number(score.toFixed(1)),
          neg_count: bucket.stats.neg_count,
          sentiment_avg: bucket.stats.sentiment_avg,
          intent_counts: bucket.stats.intents,
          message_count: bucket.stats.message_count,
        },
        driver_name: bucket.sender_name,
        driver_telegram_id: bucket.telegram_user_id,
        group_id: bucket.group_id,
      },
      promptContext: {
        kind: 'at_risk',
        driver: bucket.sender_name,
        role: bucket.role,
        group: bucket.group_name,
        metrics: {
          score: Number(score.toFixed(1)),
          neg_count: bucket.stats.neg_count,
          sentiment_avg: bucket.stats.sentiment_avg,
          intent_counts: bucket.stats.intents,
        },
        evidence: evidence.map((e) => ({ url: e.url, text: e.excerpt, at: e.at })),
      }
    });
  }

  // Stars
  for (let i = 0; i < stars.length; i += 1) {
    const { bucket, score } = stars[i];
    const evidence = topEvidence(
      bucket.messages,
      (m) => m.intent === 'praise' || m.sentiment >= 1
    );
    pendingCards.push({
      id: `star_${i}`,
      dbArgs: {
        kind: 'star',
        rank: i,
        title: `Star: ${bucket.sender_name}`,
        evidence_json: evidence,
        metrics_json: { score, pos_count: bucket.stats.pos_count, sentiment_avg: bucket.stats.sentiment_avg },
        driver_name: bucket.sender_name,
        driver_telegram_id: bucket.telegram_user_id,
        group_id: bucket.group_id,
      },
      promptContext: {
        kind: 'star',
        driver: bucket.sender_name,
        role: bucket.role,
        group: bucket.group_name,
        metrics: { score: Number(score.toFixed(1)), pos_count: bucket.stats.pos_count, sentiment_avg: bucket.stats.sentiment_avg },
        evidence: evidence.map((e) => ({ url: e.url, text: e.excerpt, at: e.at })),
      }
    });
  }

  // Home-time queue (single card, one narrative)
  if (homeTime.length) {
    pendingCards.push({
      id: 'home_time_0',
      dbArgs: {
        kind: 'home_time',
        rank: 0,
        title: `Home-time queue (${homeTime.length})`,
        evidence_json: homeTime.flatMap((h) => h.evidence).slice(0, 15),
        metrics_json: { pending: homeTime.length, rows: homeTime },
      },
      promptContext: {
        kind: 'home_time',
        pending_count: homeTime.length,
        rows: homeTime.slice(0, 10).map((h) => ({
          driver: h.driver_name,
          group: h.group_name,
          requests: h.request_count,
          days_since_first: h.days_since_first,
          home_dates: h.extracted_dates,
          cities: h.extracted_cities,
        })),
      }
    });
  }

  // Unacked (single card)
  if (unacked.length) {
    pendingCards.push({
      id: 'unacked_0',
      dbArgs: {
        kind: 'unacked',
        rank: 0,
        title: `Unacknowledged dispatcher messages (${unacked.length})`,
        evidence_json: unacked.slice(0, 10).map((m) => ({
          url: safeUrlForRow(m),
          excerpt: excerpt(m.message_text),
          group: m.group_name,
          at: m.created_at,
          urgency: m.urgency,
        })),
        metrics_json: { count: unacked.length, window_minutes: ACK_WINDOW_MINUTES },
      },
      promptContext: {
        kind: 'unacked',
        count: unacked.length,
        examples: unacked.slice(0, 6).map((m) => ({
          group: m.group_name,
          sender: m.sender_name,
          at: m.created_at,
          urgency: m.urgency,
          url: safeUrlForRow(m),
          text: excerpt(m.message_text),
        })),
      }
    });
  }

  // Silent drivers
  if (silent.length) {
    pendingCards.push({
      id: 'silent_0',
      dbArgs: {
        kind: 'silent',
        rank: 0,
        title: `Silent drivers (${silent.length})`,
        evidence_json: silent.slice(0, 10),
        metrics_json: { count: silent.length },
      },
      promptContext: {
        kind: 'silent',
        count: silent.length,
        window_days: daysBack,
        rows: silent.slice(0, 10).map((s) => ({
          driver: s.sender_name,
          group: s.group_name,
          previous_messages: s.prev_msg_count,
          last_seen: s.last_seen,
        })),
      }
    });
  }

  // Anomaly
  for (let i = 0; i < Math.min(anomalies.length, 3); i += 1) {
    const a = anomalies[i];
    const evidence = topEvidence(a.bucket.messages, () => true);
    pendingCards.push({
      id: `anomaly_${i}`,
      dbArgs: {
        kind: 'anomaly',
        rank: i,
        title: `Anomaly: ${a.bucket.sender_name}`,
        evidence_json: evidence,
        metrics_json: {
          jsd: a.jsd,
          this_week: a.currentCounts,
          baseline: a.baseCounts,
        },
        driver_name: a.bucket.sender_name,
        driver_telegram_id: a.bucket.telegram_user_id,
        group_id: a.bucket.group_id,
      },
      promptContext: {
        kind: 'anomaly',
        driver: a.bucket.sender_name,
        group: a.bucket.group_name,
        divergence: Number(a.jsd.toFixed(2)),
        this_week_intents: a.currentCounts,
        baseline_intents: a.baseCounts,
        evidence: evidence.map((e) => ({ url: e.url, text: e.excerpt, at: e.at })),
      }
    });
  }

  // Hotspots (single card with all)
  if (hotspots.length) {
    pendingCards.push({
      id: 'hotspot_0',
      dbArgs: {
        kind: 'hotspot',
        rank: 0,
        title: `Operational hotspots (${hotspots.length})`,
        evidence_json: hotspots.slice(-15).map((m) => ({
          url: safeUrlForRow(m),
          excerpt: excerpt(m.message_text),
          intent: m.intent,
          group: m.group_name,
          at: m.created_at,
        })),
        metrics_json: { count: hotspots.length },
      },
      promptContext: {
        kind: 'hotspot',
        count: hotspots.length,
        rows: hotspots.slice(-8).map((m) => ({
          kind: m.intent,
          group: m.group_name,
          sender: m.sender_name,
          at: m.created_at,
          url: safeUrlForRow(m),
          text: excerpt(m.message_text),
        })),
      }
    });
  }

  // 1:1 recommendations — top 3 names combining at-risk + anomaly + home-time
  const oneOnOnePool = new Map();
  const bump = (name, tgid, groupId, groupName, reason) => {
    if (!name) return;
    const key = `${tgid || name}:${groupId || ''}`;
    const cur = oneOnOnePool.get(key) || {
      name, tgid, group_id: groupId, group_name: groupName, reasons: [],
    };
    cur.reasons.push(reason);
    oneOnOnePool.set(key, cur);
  };
  atRisk.forEach((x) => bump(x.bucket.sender_name, x.bucket.telegram_user_id, x.bucket.group_id, x.bucket.group_name, `at-risk (score ${x.score.toFixed(1)})`));
  anomalies.forEach((a) => bump(a.bucket.sender_name, a.bucket.telegram_user_id, a.bucket.group_id, a.bucket.group_name, `tone shift (jsd ${a.jsd.toFixed(2)})`));
  homeTime.forEach((h) => bump(h.driver_name, h.driver_telegram_id, h.group_id, h.group_name, `${h.request_count} home-time asks`));
  const oneOnOne = Array.from(oneOnOnePool.values())
    .sort((a, b) => b.reasons.length - a.reasons.length)
    .slice(0, 3);
  if (oneOnOne.length) {
    pendingCards.push({
      id: 'one_on_one_0',
      dbArgs: {
        kind: 'one_on_one',
        rank: 0,
        title: `Recommended 1:1s`,
        evidence_json: null,
        metrics_json: { candidates: oneOnOne },
      },
      promptContext: {
        kind: 'one_on_one',
        candidates: oneOnOne,
      }
    });
  }

  // 6. Batch narrative generation
  const batchContext = {};
  pendingCards.forEach((c) => { batchContext[c.id] = c.promptContext; });
  const narratives = await narrateBatch(batchContext);

  // 7. Persist report envelope
  const report = await db.saveAiReport(
    groupIdForReport,
    JSON.stringify({
      format: 'insights_v2',
      days_back: daysBack,
      generated_at: new Date().toISOString(),
      pulse,
    }),
    reportType
  );

  const cards = [];

  // Pulse card — deterministic, no narrative needed
  const pulseCard = await db.createAiInsight({
    report_id: report.id,
    kind: 'pulse',
    severity: 1,
    rank: 0,
    title: `Weekly Pulse — last ${daysBack}d`,
    metrics_json: pulse,
    narrative_html: `<b>${pulse.active_drivers}</b> active drivers · <b>${pulse.total_messages}</b> messages · avg sentiment <b>${pulse.sentiment_avg}</b> (pos ${pulse.positive_messages} / neg ${pulse.negative_messages})`,
  });
  cards.push(pulseCard);

  // Insert generated cards into DB
  for (const pc of pendingCards) {
    const narr = narratives[pc.id] || {};
    const card = await db.createAiInsight({
      report_id: report.id,
      ...pc.dbArgs,
      narrative_html: narr.narrative_html || 'See evidence.',
      suggested_action: narr.suggested_action || null,
      severity: narr.severity || (pc.dbArgs.kind === 'hotspot' ? 3 : (pc.dbArgs.kind === 'star' ? 1 : 2)),
    });
    cards.push(card);
  }

  return { report, cards, pulse };
}

module.exports = {
  generateInsightReport,
  // pure helpers exported for tests
  computeSenderStats,
  computeSenderBucketsWithStats,
  scoreAtRisk,
  scoreStar,
  detectUnacked,
  detectHotspots,
  detectHomeTimeRequests,
  intentDistribution,
  jsDivergence,
  parseBatchCardNarratives,
  excerpt,
};
