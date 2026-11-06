'use strict';

/**
 * Somebody wrote `outbound` or `inbound` in a driver group: decide whether it
 * counts, CLAIM it, and start the PDF a few seconds later — without holding the
 * bot.
 *
 *   1. the word        lib/truckPhotos/trigger.js — whole word, and whether it
 *                      is bare (only the word) or says more
 *   2. switched on     and a recipient saved; otherwise nothing at all
 *   3. a driver group  `groups.group_type = 'driver'` (active or not: a truck
 *                      comes back when a driver leaves)
 *   4. who may mark    anybody but the group's own driver in a solo group
 *                      (lib/truckPhotos/whoMayMark.js). The driver's own word
 *                      is ignored — no record, no message, nothing in the group
 *   5. the claim       one row per message (database/truckPhotos/reports.js);
 *                      Telegram's redelivery of the same word finds it taken
 *   6. the wait        SETTLE_MS: an album arrives item by item, and the photos
 *                      the word is about may still be landing
 *
 * The photo the word REPLIES to is remembered now if it was not already — sent
 * before the switch went on, say — because the reply carries its file id.
 *
 * ONE REPORT AT A TIME. Each one holds its re-encoded photos in memory (up to
 * 240, services/truckPhotos/pipeline.js); two at once is a cost with no
 * benefit, so they queue behind each other. A
 * report waiting or running here is never closed by the hourly sweep
 * (`activeReportIds`), however long the queue.
 *
 * NEVER THROWS at the bot: everything is caught and logged without message text.
 */

const { readTrigger } = require('../../lib/truckPhotos/trigger');
const { mayMark } = require('../../lib/truckPhotos/whoMayMark');
const { senderName } = require('../../lib/telegram/messageParts');
const { isGroupChat } = require('./capture');

/** Long enough for an album to finish arriving; short enough to feel immediate. */
const SETTLE_MS = 5000;

let chain = Promise.resolve();
/** Reports this process has claimed and not finished: the hourly sweep leaves them alone. */
const active = new Set();

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    getSettings: require('../../database/truckPhotos/settings').getTruckPhotoSettings,
    getGroup: require('../../database/groups').getGroupByTelegramId,
    readDriverContext: require('../../database/truckPhotos/driverContext').readDriverContext,
    claimReport: require('../../database/truckPhotos/reports').claimReport,
    capture: require('./capture').captureTruckPhoto,
    run: require('./pipeline').runTruckPhotoReport,
    settleMs: SETTLE_MS,
  };
  /* eslint-enable global-require */
}

/** Run `job` after every report queued before it. The chain never rejects. */
function enqueue(job) {
  const run = chain.then(job);
  chain = run.catch(() => {});
  return run;
}

/** Start `job` after `delayMs`, in the queue. Resolves with its result; never rejects. */
function schedule(job, delayMs) {
  return new Promise((resolve) => {
    const start = () => enqueue(job).then(resolve, (err) => {
      console.error('[TRUCK PHOTOS] a report failed to run:', err?.message || String(err));
      resolve({ error: err?.message || String(err) });
    });
    if (!(delayMs > 0)) { start(); return; }
    const timer = setTimeout(start, delayMs);
    timer.unref?.();
  });
}

/**
 * @param {object} message   a Telegram message
 * @param {object} context   {telegram}
 * @returns {Promise<{handled: boolean, reason?: string, reportId?: number, done?: Promise}>}
 *   `done` settles when the report has run — for tests; the bot does not wait for it
 */
async function noticeTruckPhotoTrigger(message, { telegram } = {}, deps = defaultDeps()) {
  try {
    const trigger = readTrigger(message?.text ?? message?.caption);
    if (!trigger) return { handled: false, reason: 'no_trigger' };
    if (!isGroupChat(message.chat)) return { handled: false, reason: 'not_a_group' };
    if (!message.from || message.from.is_bot) return { handled: false, reason: 'not_a_person' };

    const settings = await deps.getSettings();
    if (!settings?.enabled || !settings.recipientTelegramId) return { handled: false, reason: 'switched_off' };
    const group = await deps.getGroup(message.chat.id);
    if (!group || group.group_type !== 'driver') return { handled: false, reason: 'not_a_driver_group' };

    let driver = { profile: null, accountIds: [], isTeam: null };
    try {
      driver = await deps.readDriverContext(group.id);
    } catch (err) {
      // Unknown: anybody may mark (lib/truckPhotos/whoMayMark.js).
      console.warn('[TRUCK PHOTOS] could not read the driver of a group:', err?.message || String(err));
    }
    if (!mayMark({ authorId: message.from.id, driverAccountIds: driver.accountIds, isTeam: driver.isTeam })) {
      return { handled: false, reason: 'the_driver' };
    }

    const reportId = await deps.claimReport({
      chatId: String(message.chat.id),
      groupId: group.id,
      triggerMessageId: message.message_id,
      kind: trigger.kind,
      triggeredBy: message.from.id ?? null,
      triggeredByName: senderName(message.from),
    });
    if (!reportId) return { handled: false, reason: 'already_claimed' };

    if (message.reply_to_message) await deps.capture(message.reply_to_message);

    active.add(reportId);
    const done = schedule(() => deps.run({
      reportId, message, trigger, group, profile: driver.profile, telegram,
    }), deps.settleMs ?? SETTLE_MS).finally(() => active.delete(reportId));
    return { handled: true, reportId, done };
  } catch (err) {
    console.error('[TRUCK PHOTOS] could not take up a hand-over message:', err?.message || String(err));
    return { handled: false, reason: 'error' };
  }
}

/** The reports queued or running in this process (not a pending claim a stopped one left). */
function activeReportIds() {
  return [...active];
}

/** For tests: forget the queue. */
function __resetForTests() {
  chain = Promise.resolve();
  active.clear();
}

module.exports = {
  SETTLE_MS, noticeTruckPhotoTrigger, activeReportIds, __resetForTests,
};
