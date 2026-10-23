'use strict';

/**
 * The worker that drains Safety replies waiting to be read.
 *
 * Event wake from capture (a reply was queued), a precise wake for the moment
 * the next one settles, and a slow idle sweep as the backstop — the shape
 * services/jobQueueScheduler.js exists for, so an idle group costs a query
 * every fifteen minutes and not one every few seconds.
 *
 * Off means off: while Safety Approvals is switched off a drain reads the
 * settings and stops, `blocked`, without touching the queue.
 *
 * Once a day the drain also deletes captured messages older than sixty days:
 * recruiting chatter is drivers' names and phone numbers, and it is kept only
 * as long as a late Safety reply could still need it.
 */

const { createQueueWakeScheduler } = require('../jobQueueScheduler');
const { withRunRecord } = require('../operations/runLedger');
const { getSafetyApprovalSettings } = require('../../database/safetyApprovals/settings');
const reviews = require('../../database/safetyApprovals/reviews');
const { purgeOldMessages } = require('../../database/safetyApprovals/messages');
const { processReview } = require('./reviewer');

const SERVICE_KEY = 'safety_approvals';
const MAX_PER_DRAIN = 10;
const RETENTION_DAYS = 60;
const PURGE_EVERY_MS = 24 * 3600 * 1000;

let scheduler = null;
let pokeDrain = null;
let draining = false;
let wokenWhileDraining = false;
let lastPurgeAt = 0;

function log(text) {
  console.log(`[SAFETY APPROVALS] ${text}`);
}

function defaultDownload(telegram) {
  // eslint-disable-next-line global-require
  const { downloadTelegramFile } = require('../telegram/fileDownload');
  return (fileId, limits) => downloadTelegramFile({ telegram }, fileId, limits);
}

/** Drain what is due. Never throws; the summary is what withRunRecord records. */
async function drainSafetyApprovals(deps = {}) {
  let settings;
  try {
    settings = await getSafetyApprovalSettings();
  } catch (err) {
    return { error: `the Safety Approvals settings could not be read (${err.message})` };
  }
  // Before the switch: messages captured while it was on are still deleted
  // on time after somebody switches it off.
  if (Date.now() - lastPurgeAt > PURGE_EVERY_MS) {
    lastPurgeAt = Date.now();
    const purged = await purgeOldMessages(RETENTION_DAYS).catch(() => 0);
    if (purged) log(`deleted ${purged} captured message(s) older than ${RETENTION_DAYS} days`);
  }

  if (!settings.enabled) return { blocked: 'Safety Approvals is switched off' };
  if (!deps.telegram) return { blocked: 'no Telegram client is available' };

  const download = deps.download || defaultDownload(deps.telegram);
  const counts = {};
  for (let i = 0; i < MAX_PER_DRAIN; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [review] = await reviews.claimDueReviews({ limit: 1 });
    if (!review) break;
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await processReview(review, { ...deps, settings, download });
    } catch (err) {
      // processReview contains its own failures; this is the database failing
      // underneath it. The lease brings the row back.
      result = 'error';
      log(`review ${review.id} could not be recorded: ${err.message}`);
    }
    counts[result] = (counts[result] || 0) + 1;
  }
  if (counts.gave_up || counts.error) {
    return { ...counts, error: `${(counts.gave_up || 0) + (counts.error || 0)} Safety reply(ies) could not be posted` };
  }
  return counts;
}

async function tick(deps = {}) {
  try {
    return await withRunRecord('safety_approvals', () => drainSafetyApprovals(deps));
  } catch (err) {
    log(`tick failed: ${err.message}`);
    return { error: err.message };
  }
}

function startSafetyApprovalWorker(deps = {}) {
  if (scheduler) return scheduler;
  const runDrain = async () => {
    if (draining) {
      // A reply queued mid-drain is looked at once this drain is done.
      wokenWhileDraining = true;
      return;
    }
    draining = true;
    try {
      do {
        wokenWhileDraining = false;
        // eslint-disable-next-line no-await-in-loop
        await tick(deps);
        // eslint-disable-next-line no-await-in-loop
        await scheduler?.afterDrain();
      } while (wokenWhileDraining && scheduler);
    } finally {
      draining = false;
    }
  };
  pokeDrain = runDrain;
  scheduler = createQueueWakeScheduler({
    onWake: () => { runDrain().catch(() => {}); },
    getNextDueAt: () => reviews.nextReviewDueAt(),
    logger: console,
  });
  scheduler.start();
  // A reply queued before a restart is not left for the idle sweep.
  runDrain().catch(() => {});
  return scheduler;
}

function stopSafetyApprovalWorker() {
  scheduler?.stop();
  scheduler = null;
  pokeDrain = null;
}

/** Capture calls this the moment it queues a reply. Fire-and-forget. */
function wakeSafetyApprovalWorker() {
  if (!scheduler?.isRunning() || !pokeDrain) return;
  pokeDrain().catch(() => {});
}

module.exports = {
  SERVICE_KEY,
  drainSafetyApprovals,
  tick,
  startSafetyApprovalWorker,
  stopSafetyApprovalWorker,
  wakeSafetyApprovalWorker,
};
