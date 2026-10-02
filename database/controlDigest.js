'use strict';

/**
 * What the morning summary reads about questions still waiting. Read-only.
 *
 * A WAITING QUESTION is the FIRST question about a finding (not a "why?"
 * follow-up, which belongs to it), delivered, unanswered, about a finding that
 * is still open. A question about something already fixed in the admin is not
 * waiting for anybody — naming it would ask the owner about the past.
 *
 * Unlike `operationalNotificationHealth.js` this returns finding TITLES: the
 * summary goes to the same group the questions went to, and every title here
 * was already in a question there. It is never published on /api/health.
 */
const { query } = require('./pool');

/**
 * @returns {Promise<{total:number, oldest:{title:string|null, askedAt:string}[]}|null>}
 *   null when it could not be read — "could not tell" is not "none waiting".
 */
async function listWaitingQuestions({ limit = 3, chatId = null } = {}) {
  // NO CHAT, NO TITLES. The summary may only name questions asked in the chat
  // it is going to — see services/control/dailyDigest.js.
  if (chatId == null || String(chatId).trim() === '') return null;
  try {
    const res = await query(
      `SELECT title, created_at, COUNT(*) OVER ()::int AS total
         FROM (
           -- ONE PER FINDING. A question re-asked after the repeat window is
           -- a second notice about the same thing, not a second thing waiting;
           -- the age shown is the FIRST time it was asked.
           SELECT DISTINCT ON (n.finding_id) f.title, n.created_at
             FROM operational_notifications n
             JOIN operational_findings f ON f.id = n.finding_id
            WHERE n.question_json IS NOT NULL
              AND n.chat_id = $2
              AND n.parent_notice_id IS NULL
              AND n.answered_at IS NULL
              AND n.state = 'delivered'
              AND f.status = 'open'
              AND (f.snoozed_until IS NULL OR f.snoozed_until <= NOW())
            ORDER BY n.finding_id, n.created_at ASC
         ) waiting
        ORDER BY created_at ASC
        LIMIT $1`,
      [Math.max(1, Math.min(20, Number(limit) || 3)), String(chatId)]
    );
    return {
      total: res.rows[0]?.total || 0,
      oldest: res.rows.map((r) => ({ title: r.title || null, askedAt: r.created_at })),
    };
  } catch (_) {
    return null;
  }
}

module.exports = { listWaitingQuestions };
