'use strict';

/**
 * The hourly look at Truck Photos — rides the scheduler's retention tick
 * (services/schedulerService.js) rather than arming a timer of its own.
 *
 * A CLAIM A STOPPED PROCESS LEFT BEHIND. A report is claimed, then made a few
 * seconds later; a deploy or a crash in between leaves the claim `pending` for
 * ever, and the person who wrote `outbound` would never hear why no PDF came.
 * A claim still pending after STALE_MINUTES that this process is not working
 * on (services/truckPhotos/triggerHandler.js `activeReportIds` — queued reports
 * can wait behind each other) is finished as `failed`, and the recipient is
 * told privately, in the same fixed words as every other failure.
 *
 * AND THE RUN LEDGER (services/operations/runLedger.js). Reports are made when
 * somebody writes the word, which may be days apart; this pass is what keeps
 * `truck_photo_reports` from reading as stopped in between. While the feature
 * is switched off it reports `blocked` — switched off, not broken.
 */

const { reasonText, failureMessage } = require('../../lib/truckPhotos/failureText');

const STALE_MINUTES = 30;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    getSettings: require('../../database/truckPhotos/settings').getTruckPhotoSettings,
    failStaleReports: require('../../database/truckPhotos/reports').failStaleReports,
    activeReportIds: () => require('./triggerHandler').activeReportIds(),
    tellRecipient: require('./deliver').tellRecipient,
    telegram: () => require('../../bot/bot').bot?.telegram || null,
  };
  /* eslint-enable global-require */
}

/** One pass. Returns a summary the ledger reads (`blocked` while switched off). */
async function sweepTruckPhotoReports(deps = defaultDeps()) {
  const settings = await deps.getSettings();
  // A report this process still has queued or running is not left behind.
  const stale = await deps.failStaleReports(STALE_MINUTES, reasonText('interrupted'), deps.activeReportIds());
  const telegram = stale.length ? deps.telegram() : null;
  let told = 0;
  for (const report of stale) {
    // eslint-disable-next-line no-await-in-loop
    const sent = await deps.tellRecipient({
      telegram,
      recipient: settings.recipientTelegramId,
      text: failureMessage({
        code: 'interrupted', kind: report.kind, chatTitle: report.groupName,
        markedBy: report.triggeredByName, at: report.createdAt,
      }),
    });
    if (sent) told += 1;
  }
  if (stale.length) console.log(`[TRUCK PHOTOS] ${stale.length} unfinished report(s) closed as failed`);
  if (!settings.enabled) {
    return { blocked: 'Truck Photos is switched off (Settings → Truck Photos)', closed: stale.length, told };
  }
  return { closed: stale.length, told };
}

/** The pass, recorded in the run ledger. Never throws. */
async function runTruckPhotoSweep(deps) {
  try {
    // eslint-disable-next-line global-require
    const { withRunRecord } = require('../operations/runLedger');
    return await withRunRecord('truck_photo_reports', () => sweepTruckPhotoReports(deps));
  } catch (err) {
    console.error('[TRUCK PHOTOS] the hourly pass failed:', err?.message || String(err));
    return { error: err?.message || String(err) };
  }
}

module.exports = { STALE_MINUTES, sweepTruckPhotoReports, runTruckPhotoSweep };
