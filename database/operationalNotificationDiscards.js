/**
 * What was never said, and how much of it.
 *
 * Split out of `operationalNotifications.js` because it answers a different
 * question from the outbox it lives beside: the outbox is about delivering a
 * notice, this is about the notices a missing destination meant nobody ever
 * got. Two tables of its own (`notification_discards`,
 * `notification_discard_keys`), no reader in the send path, and a hard rule
 * that neither function may throw — a counter that can break the thing it
 * counts is worse than no counter.
 *
 * Re-exported from `database/operationalNotifications.js`, so every existing
 * caller keeps its import path.
 */
const { query } = require('./pool');

/**
 * Count a notice that was thrown away before it was ever recorded.
 *
 * NOT AN ERROR PATH. With no destination configured, discarding is the right
 * behaviour and was chosen deliberately: enqueuing would mean that on the day a
 * destination is finally set, months of stale alerts flood a live staff chat.
 * What was missing is that the COST of that decision was invisible — every
 * feature running, finding real things, and saying nothing, which is the exact
 * silence this whole project started from.
 *
 * Nine rows, forever. No body, no subject: keeping those would be the backlog
 * this design refuses to build, one table over.
 *
 * Never throws — a counter that can break the thing it counts is worse than no
 * counter.
 */
async function recordDiscard(category, reason = 'no_destination', noticeKey = null) {
  try {
    // ONE COUNT PER THING UNHEARD, NOT ONE PER PASS.
    //
    // The background watches re-derive the same condition every few minutes.
    // Counting each re-derivation made `load_lifecycle` reach 95 in nine
    // minutes for about 48 loads — a number that reads as a catastrophe and
    // describes one unset setting. So the key claims its row first, and only a
    // key nobody has seen before moves the counter.
    //
    // A caller with no key still counts every call: that is the old behaviour,
    // kept deliberately rather than silently dropped, because a notice with no
    // subject at all is a one-off and counting it once per occurrence is right.
    if (noticeKey) {
      const claimed = await query(
        `INSERT INTO notification_discard_keys (notice_key, category, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (notice_key) DO NOTHING
         RETURNING notice_key`,
        [String(noticeKey), String(category), String(reason)]
      );
      // Already counted. `last_discarded_at` is deliberately NOT touched: it
      // answers "when did something go unheard", and a re-check of a load from
      // Tuesday is not something going unheard today.
      if (claimed.rowCount === 0) return false;
    }

    await query(
      `INSERT INTO notification_discards
         (category, reason, discarded_count, first_discarded_at, last_discarded_at)
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (category) DO UPDATE SET
         reason = EXCLUDED.reason,
         discarded_count = notification_discards.discarded_count + 1,
         last_discarded_at = NOW()`,
      [String(category), String(reason)]
    );
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * What has been thrown away, and since when.
 *
 * "Not configured" is a sentence nobody acts on. "1,247 notices were discarded
 * this week, 900 of them Needs attention" is one somebody does.
 */
async function summariseDiscards() {
  try {
    const res = await query(
      `SELECT category, reason, discarded_count, first_discarded_at, last_discarded_at
         FROM notification_discards ORDER BY discarded_count DESC`
    );
    const byCategory = {};
    // AND WHY, which is the half a count cannot answer. "You switched this
    // category off" and "there is nowhere to send it" are the same number and
    // opposite problems — one is a decision, the other is a gap nobody has
    // noticed — and the whole reason these rows exist is that a discarded
    // notice used to be silence.
    const byReason = {};
    let total = 0;
    let since = null;
    for (const row of res.rows) {
      const n = Number(row.discarded_count) || 0;
      byCategory[row.category] = n;
      byReason[row.category] = row.reason || null;
      total += n;
      const at = row.first_discarded_at;
      if (at && (!since || new Date(at) < new Date(since))) since = at;
    }
    return { available: true, total, byCategory, byReason, since };
  } catch (_) {
    return { available: false, total: 0, byCategory: {}, byReason: {}, since: null };
  }
}

module.exports = {
  recordDiscard,
  summariseDiscards,
};
