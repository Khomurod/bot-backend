'use strict';

/**
 * Telling the owner when Bitrix keeps saying no (owner, 14 November 2026,
 * decision d): three failed or refused attempts in a row for one feature →
 * ONE operational notice, through the one door (services/notifications/
 * send.js, category `system_errors`). The rule is pure —
 * lib/activityLog/failureStreak.js; this reads what it needs and sends.
 *
 * Said once per streak: the notice key ends in the streak's first entry, so
 * the outbox's UNIQUE key refuses a second copy whatever this decides. At
 * most one per feature every six hours (`noticeSentWithin`). Never throws.
 */

const {
  WINDOW, QUIET_HOURS, decideFailureNotice, failureNoticeText,
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

/**
 * @param {string} trigger  the feature whose entry just failed
 * @returns {Promise<{notified: boolean, why: string}>}
 */
async function checkFailureStreak(trigger, deps = defaultDeps()) {
  try {
    if (!trigger) return { notified: false, why: 'no feature named' };
    const entries = await deps.store.recentForTrigger(trigger, WINDOW);
    const prefix = `${noticeKeyFor(CATEGORY, SUBJECT_TYPE, trigger)}:`;
    const decision = decideFailureNotice({
      entries,
      // Read only when it could matter: a streak under three costs no notices read.
      toldWithinQuietHours: entries.length >= 3 && await deps.notices.noticeSentWithin(prefix, QUIET_HOURS),
    });
    if (!decision.notify) return { notified: false, why: decision.why };
    const words = failureNoticeText({ trigger, streak: decision.streak, latest: entries[0] });
    const sent = await deps.notify({
      category: CATEGORY,
      ...words,
      subjectType: SUBJECT_TYPE,
      subjectId: trigger,
      discriminator: `streak:${decision.streakStartId}`,
      evidence: { trigger, streak: decision.streak, streakStartEntryId: decision.streakStartId },
    });
    return { notified: Boolean(sent?.recorded), why: sent?.reason || decision.why };
  } catch (err) {
    console.warn('[ACTIVITY-LOG] could not check the failure streak:', String(err?.message || err).slice(0, 160));
    return { notified: false, why: 'error' };
  }
}

module.exports = { checkFailureStreak, CATEGORY, SUBJECT_TYPE };
