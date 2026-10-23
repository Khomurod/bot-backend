'use strict';

/**
 * Accounting's reason for "Not charging" a home-time violation, kept as a
 * lesson for the home-time readers (the owner, 23 October 2026: "if someone
 * explains why, learn from that reason too").
 *
 * THE DRIVER IS NOT NAMED in the lesson. What is worth learning is the kind of
 * situation and why it was let go; a name would only carry a person's private
 * circumstances into every later prompt. The alert in the accounting group
 * keeps the name, as it always has.
 *
 * Never throws: the reason is already written into the alert, and learning
 * from it is extra. See docs/architecture/ai-learning.md.
 */
const { invalidateLessons } = require('./hooks');

const SCOPE = 'home_time';

/** "came home early after 12 days on the road; stayed home 6 days" — no name. */
function aboutViolation(rows) {
  const first = rows[0] || {};
  const parts = [];
  const kinds = new Set(rows.map((r) => r.violation));
  if (kinds.has('early')) {
    parts.push(`came home early${first.road_days != null ? ` after ${first.road_days} days on the road` : ''}`);
  }
  if (kinds.has('overstay')) {
    parts.push(`stayed home too long${first.home_days != null ? ` (${first.home_days} days)` : ''}`);
  }
  return `A company driver ${parts.join(' and ') || 'broke the home-time policy'}; accounting did not charge them`;
}

async function recordAccountingReason(rows, reason, { name = null, telegramUserId = null } = {}, deps = {}) {
  const text = String(reason || '').trim();
  if (!Array.isArray(rows) || !rows.length || !text) return null;
  try {
    // eslint-disable-next-line global-require
    const store = deps.store || require('../../../database/aiLessons');
    const lesson = await store.addLesson({
      scope: SCOPE,
      source: 'accounting_reason',
      about: aboutViolation(rows),
      statement: text.slice(0, 1000),
      createdByTelegramId: telegramUserId,
      createdByName: name,
    });
    invalidateLessons(SCOPE);
    return lesson;
  } catch (err) {
    console.warn('[AI LEARNING] could not keep accounting\'s reason:', err.message);
    return null;
  }
}

module.exports = { recordAccountingReason, aboutViolation };
