/**
 * Per-sender AGGREGATION for AI Insights — PURE, deterministic, no AI.
 *
 * Everything a report says about a person is computed here from annotated
 * messages before any model is involved, which is what makes the numbers on a
 * card reproducible and testable.
 *
 * Split out of services/aiInsightsService.js, which re-exports several of these
 * for its unit tests.
 */
const { buildTelegramMessageUrl } = require('../telegramUrl');
const { MAX_EVIDENCE_PER_CARD } = require('./constants');

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

module.exports = {
  excerpt,
  safeUrlForRow,
  computeSenderStats,
  computeSenderBucketsWithStats,
  topEvidence,
};
