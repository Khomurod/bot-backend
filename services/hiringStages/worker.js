'use strict';

/**
 * The worker that reads queued recruiting conversations for a Bitrix stage.
 *
 * The same shape as services/safetyApprovals/worker.js: an event wake from
 * capture, a precise wake when the next conversation settles, and the slow
 * idle sweep of services/jobQueueScheduler.js as the backstop.
 *
 * Off means off: while Safety Approvals or its stage proposals are switched
 * off, a drain reads the settings and stops, `blocked`, without touching the
 * queue. Once a day it first deletes proposals and queue rows older than
 * sixty days — the same life as the captured messages they were read from.
 */

const { createQueueWakeScheduler } = require('../jobQueueScheduler');
const { withRunRecord } = require('../operations/runLedger');
const { getSafetyApprovalSettings } = require('../../database/safetyApprovals/settings');
const threads = require('../../database/hiringStages/threads');
const { purgeOldProposals } = require('../../database/hiringStages/proposals');
const { processThread } = require('./reviewer');

const SERVICE_KEY = 'hiring_stage_proposals';
const MAX_PER_DRAIN = 10;
const RETENTION_DAYS = 60;
const PURGE_EVERY_MS = 24 * 3600 * 1000;

let scheduler = null;
let pokeDrain = null;
let draining = false;
let wokenWhileDraining = false;
let lastPurgeAt = 0;

/** Drain what is due. Never throws; the summary is what withRunRecord records. */
async function drainHiringStages(deps = {}) {
  let settings;
  try {
    settings = await getSafetyApprovalSettings();
  } catch (err) {
    return { error: `the Safety Approvals settings could not be read (${err.message})` };
  }
  // Before the switch, so what was proposed while it was on is still deleted
  // on time after somebody switches it off.
  if (Date.now() - lastPurgeAt > PURGE_EVERY_MS) {
    lastPurgeAt = Date.now();
    const purged = (await purgeOldProposals(RETENTION_DAYS).catch(() => 0))
      + (await threads.purgeOldThreads(RETENTION_DAYS).catch(() => 0));
    if (purged) console.log(`[HIRING STAGES] deleted ${purged} proposal/queue row(s) older than ${RETENTION_DAYS} days`);
  }
  if (!settings.enabled) return { blocked: 'Safety Approvals is switched off' };
  if (!settings.stageProposalsEnabled) return { blocked: 'Bitrix stage proposals are switched off' };
  if (!deps.telegram) return { blocked: 'no Telegram client is available' };

  const counts = {};
  for (let i = 0; i < MAX_PER_DRAIN; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [thread] = await threads.claimDueThreads({ limit: 1 });
    if (!thread) break;
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await processThread(thread, { ...deps, settings });
    } catch (err) {
      // processThread contains its own failures; this is the database failing
      // underneath it. The lease brings the row back.
      result = 'error';
      console.error(`[HIRING STAGES] conversation ${thread.id} could not be recorded: ${err.message}`);
    }
    counts[result] = (counts[result] || 0) + 1;
  }
  if (counts.gave_up || counts.error) {
    return { ...counts, error: `${(counts.gave_up || 0) + (counts.error || 0)} conversation(s) could not be read` };
  }
  return counts;
}

async function tick(deps = {}) {
  try {
    return await withRunRecord('hiring_stage_proposals', () => drainHiringStages(deps));
  } catch (err) {
    console.error(`[HIRING STAGES] tick failed: ${err.message}`);
    return { error: err.message };
  }
}

function startHiringStageWorker(deps = {}) {
  if (scheduler) return scheduler;
  const runDrain = async () => {
    if (draining) {
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
    getNextDueAt: () => threads.nextThreadDueAt(),
    logger: console,
  });
  scheduler.start();
  runDrain().catch(() => {});
  return scheduler;
}

function stopHiringStageWorker() {
  scheduler?.stop();
  scheduler = null;
  pokeDrain = null;
}

/** Capture calls this the moment it queues a conversation. Fire-and-forget. */
function wakeHiringStageWorker() {
  if (!scheduler?.isRunning() || !pokeDrain) return;
  pokeDrain().catch(() => {});
}

module.exports = {
  SERVICE_KEY,
  drainHiringStages,
  tick,
  startHiringStageWorker,
  stopHiringStageWorker,
  wakeHiringStageWorker,
};
