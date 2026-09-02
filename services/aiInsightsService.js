/**
 * AI Insights — report orchestration.
 *
 * Builds a manager's insight report for a window in seven ordered phases:
 * refresh role consensus, pull annotated messages, aggregate per sender, run the
 * deterministic detectors, narrate the resulting cards in ONE batched AI call,
 * persist the envelope, then insert the cards.
 *
 * The phase order is the contract, so it stays in one readable function here
 * while everything it composes lives in focused modules:
 *
 *   ./aiInsights/constants.js    the score thresholds and per-card caps
 *   ./aiInsights/senderStats.js  PURE per-sender aggregation
 *   ./aiInsights/scoring.js      PURE at-risk / star rules
 *   ./aiInsights/detectors.js    deterministic finding of each card kind
 *   ./aiInsights/narration.js    the single batched wording call
 *
 * Findings are deterministic BEFORE the model is involved; narration may only
 * word them. That ordering is why report numbers are reproducible.
 */
const db = require('../database/db');
const { ensureAnnotationsForRange } = require('./aiAnnotationService');
const {
  AT_RISK_SCORE_THRESHOLD, STAR_SCORE_THRESHOLD, MAX_CARDS_PER_KIND, ACK_WINDOW_MINUTES,
} = require('./aiInsights/constants');
const {
  excerpt, safeUrlForRow, computeSenderStats, computeSenderBucketsWithStats, topEvidence,
} = require('./aiInsights/senderStats');
const { scoreAtRisk, scoreStar } = require('./aiInsights/scoring');
const {
  detectUnacked, detectHotspots, detectHomeTimeRequests, detectSilentDrivers,
  intentDistribution, jsDivergence, detectAnomalies, computePulse,
} = require('./aiInsights/detectors');
const { parseBatchCardNarratives, narrateBatch } = require('./aiInsights/narration');

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
