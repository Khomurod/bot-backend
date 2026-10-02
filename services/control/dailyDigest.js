'use strict';

/**
 * Sending the morning summary. Rides the consistency sweep.
 *
 * ONCE A DAY, AND THE OUTBOX IS WHAT GUARANTEES IT. Every fifteen minutes
 * between 08:00 and 20:00 Chicago time this composes the day's summary and
 * hands it to `notify()` with the local date as its discriminator. The notice
 * key is UNIQUE, so the first call that day is delivered and every later one
 * — including after a restart — comes back `already_sent`. No timer state,
 * no claim table: the same guarantee every other "say it once" in this
 * application rests on.
 *
 * IT COSTS ONE CHEAP READ before that: `noticeSentWithin` on the day's key, so
 * the remaining forty-seven passes of the day do not build a summary only to
 * have it refused.
 *
 * Off when the control channel is off — the summary exists to bring the
 * questions back, and a switched-off channel asks none.
 *
 * NEVER THROWS. A summary that could not be built is a skipped summary, and
 * the next pass tries again.
 */
const defaultSettings = require('../../database/controlSettings');
const defaultNotices = require('../../database/operationalNotifications');
const defaultDigest = require('../../database/controlDigest');
const defaultCorrections = require('../../database/operationalCorrections');
const defaultFindings = require('../../database/operationalFindings');
const defaultSystemHealth = require('../../database/systemHealth');
const defaultSend = require('../notifications/send');
const { digestDayFor, composeDigest, MAX_WAITING_NAMED } = require('../../lib/control/digest');
const { serviceLabel } = require('../../lib/operations/backgroundServiceCatalog');

const SUBJECT_TYPE = 'control_digest';
const SUBJECT_ID = 'daily';

function defaultDeps() {
  return {
    settings: defaultSettings,
    notices: defaultNotices,
    digest: defaultDigest,
    corrections: defaultCorrections,
    findings: defaultFindings,
    systemHealth: defaultSystemHealth,
    notify: defaultSend.notify,
  };
}

/** The notice key `notify` writes for one day's summary. */
function digestKeyFor(day) {
  return `needs_attention:${SUBJECT_TYPE}:${SUBJECT_ID}:${day}`;
}

/**
 * @param {object} [options]
 * @param {Date}   [options.now]
 * @returns {Promise<{sent:boolean, day?:string|null, reason?:string}>}
 */
async function runDailyDigest({ now = new Date() } = {}, deps = defaultDeps()) {
  const day = digestDayFor(now);
  if (!day) return { sent: false, day: null, reason: 'not_the_hour' };

  const settings = await deps.settings.getControlSettings().catch(() => ({ enabled: true }));
  if (settings.enabled === false) return { sent: false, day, reason: 'disabled' };

  // A read that failed is treated as "already sent": a second summary in one
  // day is the nuisance this is built to avoid, and tomorrow will come.
  const already = await deps.notices.noticeSentWithin(digestKeyFor(day), 24).catch(() => true);
  if (already) return { sent: false, day, reason: 'already_sent' };

  const since = new Date(new Date(now).getTime() - 24 * 3600_000).toISOString();
  const [waiting, changes, findings, health] = await Promise.all([
    deps.digest.listWaitingQuestions({ limit: MAX_WAITING_NAMED }).catch(() => null),
    deps.corrections.summariseCorrections({ sinceIso: since }).catch(() => null),
    deps.findings.summariseFindings().catch(() => null),
    deps.systemHealth.summariseHealthStates().catch(() => null),
  ]);

  const body = composeDigest({
    waiting: waiting ? waiting.oldest : null,
    waitingTotal: waiting ? waiting.total : null,
    changes,
    findings,
    systemsDown: health ? (health.down || []).map(serviceLabel) : null,
    now,
  });

  const result = await Promise.resolve(deps.notify({
    category: 'needs_attention',
    title: body.title,
    lines: body.lines,
    subjectType: SUBJECT_TYPE,
    subjectId: SUBJECT_ID,
    discriminator: day,
    severity: 'info',
  })).catch(() => null);

  return {
    sent: Boolean(result?.recorded),
    day,
    reason: result?.recorded ? null : (result?.reason || 'not_sent'),
    waiting: waiting ? waiting.total : null,
  };
}

module.exports = {
  SUBJECT_TYPE, SUBJECT_ID, digestKeyFor, runDailyDigest, defaultDeps,
};
