/**
 * The notification outbox as /api/health reads it — counts only.
 *
 * Split from `operationalNotifications.js` because these answer a different
 * question from the outbox they sit beside: the outbox delivers a notice, and
 * these say whether the whole arrangement is working when nobody is watching.
 *
 * The rule both obey: NO BODY, NO SUBJECT, NO CHAT ID. Whatever is returned
 * here is published on an unauthenticated endpoint, so it is numbers and at
 * most a timestamp. And neither may throw — a summary that can break the
 * health check is worse than a missing number.
 *
 * Re-exported from `database/operationalNotifications.js`, so every existing
 * caller keeps its import path.
 */
const { query } = require('./pool');

/**
 * What has been ASKED, as counts.
 *
 * WITHOUT THIS THE CONTROL CHANNEL CANNOT BE VERIFIED FROM OUTSIDE. The replies
 * summary answers "has anybody answered", and zero replies is the reading
 * whether Wenze asked five questions nobody answered or asked none at all —
 * two states that need opposite responses from whoever is reading the health
 * endpoint. `delivered` is the one that says the channel is actually working:
 * a question enqueued and never sent reached nobody.
 *
 * Counts and one timestamp. No chat id, no finding title, no body.
 */
async function summariseControlQuestions() {
  try {
    const res = await query(
      `SELECT COUNT(*)::int AS asked,
              COUNT(*) FILTER (WHERE telegram_message_id IS NOT NULL)::int AS delivered,
              COUNT(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered,
              COUNT(*) FILTER (WHERE answered_at IS NULL
                               AND state IN ('pending', 'delivered'))::int AS outstanding,
              MAX(created_at) AS last_asked_at
         FROM operational_notifications
        WHERE question_json IS NOT NULL`
    );
    const r = res.rows[0] || {};
    return {
      available: true,
      asked: r.asked || 0,
      delivered: r.delivered || 0,
      answered: r.answered || 0,
      outstanding: r.outstanding || 0,
      lastAskedAt: r.last_asked_at || null,
    };
  } catch (_) {
    return { available: false, asked: 0, delivered: 0, answered: 0, outstanding: 0, lastAskedAt: null };
  }
}

/** For /api/health: what is stuck, and how long it has been stuck. */
async function summariseNotifications() {
  const res = await query(
    `SELECT COUNT(*) FILTER (WHERE state = 'pending')::int   AS pending,
            COUNT(*) FILTER (WHERE state = 'failed')::int    AS failed,
            COUNT(*) FILTER (WHERE state = 'abandoned')::int AS abandoned,
            COUNT(*) FILTER (WHERE state = 'delivered'
                             AND delivered_at > NOW() - INTERVAL '24 hours')::int AS delivered24h,
            MIN(created_at) FILTER (WHERE state = 'pending') AS oldest_pending_at
       FROM operational_notifications`
  );
  const r = res.rows[0] || {};
  return {
    pending: r.pending || 0,
    failed: r.failed || 0,
    abandoned: r.abandoned || 0,
    delivered24h: r.delivered24h || 0,
    oldestPendingAt: r.oldest_pending_at || null,
  };
}

module.exports = {
  summariseControlQuestions,
  summariseNotifications,
};
