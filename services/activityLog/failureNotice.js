'use strict';

/**
 * Telling the owner when Bitrix keeps saying no (owner, 14 November 2026,
 * decision d): three failed or refused attempts in a row for one feature →
 * ONE operational notice, through the one door (services/notifications/
 * send.js, category `system_errors`). The rule is pure —
 * lib/activityLog/failureStreak.js; this reads what it needs and sends.
 *
 * WHAT IT READS, cheapest first, and only as far as the answer needs:
 *   1. the feature's newest 20 entries Bitrix answered (id and result only) —
 *      a streak under three stops here;
 *   2. a streak longer than that: where it began (`streakStartId`, two
 *      one-row reads), so the key is the streak's own and never guessed;
 *   3. the outbox, on its subject index: is there a notice under this
 *      streak's key already, and any about this feature in six hours;
 *   4. the newest entry's words, only when it will be said.
 *
 * Said once per streak: the notice key ends in the streak's first entry, and
 * the outbox's UNIQUE key refuses a second copy whatever this decides. Never
 * throws.
 */

const {
  WINDOW, QUIET_HOURS, STREAK_THRESHOLD, currentStreak, decideFailureNotice, failureNoticeText,
} = require('../../lib/activityLog/failureStreak');
const { noticeKeyFor } = require('../../lib/notifications/compose');

const CATEGORY = 'system_errors';
const SUBJECT_TYPE = 'activity_log';

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/activityLog'),
    notices: require('../../database/operationalNotifications'),
    notify: (notice) => require('../notifications/send').notify(notice),
  };
  /* eslint-enable global-require */
}

const discriminatorFor = (startId) => `streak:${startId}`;

/**
 * @param {string} trigger  the feature whose entry just failed
 * @returns {Promise<{notified: boolean, why: string}>}
 */
async function checkFailureStreak(trigger, deps = defaultDeps()) {
  try {
    if (!trigger) return { notified: false, why: 'no feature named' };
    const entries = await deps.store.recentForTrigger(trigger, WINDOW);
    const streak = currentStreak(entries);
    if (streak.length < STREAK_THRESHOLD) return { notified: false, why: 'not enough failures in a row' };
    const exactStartId = streak.complete ? null : await deps.store.streakStartId(trigger);
    const startId = streak.complete ? streak.startId : exactStartId;
    const told = startId ? await deps.notices.noticeAboutSubject({
      category: CATEGORY,
      subjectType: SUBJECT_TYPE,
      subjectId: trigger,
      noticeKey: noticeKeyFor(CATEGORY, SUBJECT_TYPE, trigger, discriminatorFor(startId)),
      hours: QUIET_HOURS,
    }) : {};
    const decision = decideFailureNotice({
      entries, exactStartId, toldThisStreak: told.keyExists === true, toldWithinQuietHours: told.sentWithin === true,
    });
    if (!decision.notify) return { notified: false, why: decision.why };
    const latest = (await deps.store.entryWords(entries[0].id)) || entries[0];
    const words = failureNoticeText({
      trigger, streak: decision.streak, atLeast: decision.atLeast, latest,
    });
    const sent = await deps.notify({
      category: CATEGORY,
      ...words,
      subjectType: SUBJECT_TYPE,
      subjectId: trigger,
      discriminator: discriminatorFor(decision.streakStartId),
      evidence: { trigger, streak: decision.streak, streakStartEntryId: decision.streakStartId },
    });
    return { notified: Boolean(sent?.recorded), why: sent?.reason || decision.why };
  } catch (err) {
    console.warn('[ACTIVITY-LOG] could not check the failure streak:', String(err?.message || err).slice(0, 160));
    return { notified: false, why: 'error' };
  }
}

module.exports = { checkFailureStreak, CATEGORY, SUBJECT_TYPE };
