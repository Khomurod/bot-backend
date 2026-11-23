'use strict';

/**
 * Making one hand-over's PDF, from a claimed `outbound` / `inbound` message to
 * the recipient's chat. Runs after the claim and the settle delay
 * (services/truckPhotos/triggerHandler.js), one report at a time.
 *
 *   1. which photos   lib/truckPhotos/selectPhotos.js — the reply's album and
 *                     its neighbours (`lookback_hours` either side of it), or
 *                     the last `lookback_hours`; never one already in a PDF,
 *                     never one sent after the word. Videos are chosen the same
 *                     way and listed as links, never downloaded
 *   2. the words      a message that is more than the bare word is checked by a
 *                     model (aiCheck.readHandover); "not about the truck" is
 *                     recorded and nothing is sent; "could not tell" — or no
 *                     model — is no PDF and the recipient is told, never a guess
 *   3. the photos     downloaded one at a time (pdf.preparePhotos)
 *   4. the sort       a model sorts each photo — the truck, Wenze's own
 *                     hand-over form, or not the truck (aiCheck.sortPhotos,
 *                     lib/truckPhotos/photoKinds.js); only a SURE "not the
 *                     truck" leaves a photo out. Photos no model looked at stay
 *                     in, the cover says "NOT CHECKED BY AI", and the owner is
 *                     told (uncheckedNotice.js)
 *   5. the PDFs       truck photos in parts of `max_photos_per_pdf` (60), each
 *                     with a cover, and the hand-over form at the end of the
 *                     last part (lib/truckPhotos/pagePlan.js); the truck number
 *                     is the chat title's, checked against the profile and the
 *                     Dispatcher Board (lib/truckPhotos/truckNumber.js); an
 *                     inbound cover names the last outbound
 *   6. delivery       to the recipient; then 👍 on the word; then the photos
 *                     are marked as sent and the report finished
 *
 * A PHOTO SEEN LATE (`job.anchorSeenLate`, services/truckPhotos/triggerHandler.js):
 * the word replied to a photo Wenze had not seen when it was sent, so the rest
 * of its album may be missing. The cover and the caption say so.
 *
 * WHEN NO PDF CAN BE MADE the recipient is told privately, in fixed words
 * (lib/truckPhotos/failureText.js). NOTHING IS EVER WRITTEN IN THE DRIVER'S
 * GROUP. `ai_assisted` records whether a model's answer shaped the report.
 */

const { selectPhotos, windowStart, windowEnd } = require('../../lib/truckPhotos/selectPhotos');
const { planPages } = require('../../lib/truckPhotos/pagePlan');
const { decideTruckNumber, boardTrucksNaming } = require('../../lib/truckPhotos/truckNumber');
const { extractUnitFromGroupName } = require('../../lib/drivers/driverGroupTitle');
const { videoEntry, chicagoTime } = require('../../lib/truckPhotos/pdfLayout');
const { reasonText, failureMessage } = require('../../lib/truckPhotos/failureText');
const { senderName, replyTarget } = require('../../lib/telegram/messageParts');
const { hasMedia } = require('./capture');
const { MAX_PDF_BYTES, sendReportParts } = require('./sendParts');

/**
 * Downloads and model calls stop here (what was not reached is counted, or
 * kept unfiltered); each send has its own three minutes. A report still
 * running is never closed by the hourly sweep — it skips the reports this
 * process has queued (triggerHandler.activeReportIds).
 */
const PIPELINE_DEADLINE_MS = 12 * 60 * 1000;
/**
 * Four PDFs' worth. Every photo is held in memory (re-encoded) until its PDF is
 * sent, so a reply to a days-old photo cannot pull hundreds in; the ones
 * closest to the word are kept, and the cover says how many were left out.
 */
const MAX_PHOTOS_PER_REPORT = 240;
/** Videos are links on a page of their own; more than this in one hand-over is not a hand-over. */
const MAX_VIDEOS_PER_REPORT = 60;

function defaultDeps() {
  /* eslint-disable global-require */
  const photos = require('../../database/truckPhotos/photos');
  const reports = require('../../database/truckPhotos/reports');
  const ai = require('./aiCheck');
  const pdf = require('./pdf');
  const deliver = require('./deliver');
  return {
    getSettings: require('../../database/truckPhotos/settings').getTruckPhotoSettings,
    getPhotoByMessage: photos.getPhotoByMessage,
    listPhotosSince: photos.listPhotosSince,
    markPhotosInReport: photos.markPhotosInReport,
    finishReport: reports.finishReport,
    lastSentOutbound: reports.lastSentOutbound,
    readHandover: ai.readHandover,
    sortPhotos: ai.sortPhotos,
    readBoardTrucks: require('../../database/truckPhotos/boardTrucks').readPresentBoardTrucks,
    tellOwnerUnchecked: require('./uncheckedNotice').tellOwnerUnchecked,
    preparePhotos: pdf.preparePhotos,
    prepareThumbnails: pdf.prepareThumbnails,
    buildPdf: pdf.buildPdf,
    sendPdf: deliver.sendPdf,
    reactDelivered: deliver.reactDelivered,
    tellRecipient: deliver.tellRecipient,
    now: () => Date.now(),
  };
  /* eslint-enable global-require */
}

/** The photo or video this word is about: itself when it carries one, else the one it replies to. */
async function findAnchor({ message, chatId, triggerAt }, deps) {
  if (hasMedia(message)) {
    return { messageId: message.message_id, mediaGroupId: message.media_group_id ?? null, sentAt: triggerAt };
  }
  const replied = replyTarget(message);
  if (replied === null) return null;
  return deps.getPhotoByMessage(chatId, replied);
}

/**
 * @param {object} job
 * @param {number} job.reportId           the claimed report
 * @param {object} job.message            the Telegram message with the word
 * @param {{kind: string, bare: boolean}} job.trigger
 * @param {{id: number, group_name?: string}} job.group
 * @param {object|null} [job.profile]     the driver's profile, for the cover
 * @param {object} job.telegram
 * @returns {Promise<object>} a summary for the run ledger
 */
async function produceReport(job, deps = defaultDeps()) {
  const {
    reportId, message, trigger, group, profile = null, telegram, anchorSeenLate = false,
  } = job;
  const chatId = String(message.chat.id);
  const triggerAt = Number.isFinite(message.date) ? new Date(message.date * 1000) : new Date(deps.now());
  const markedBy = senderName(message.from);
  const deadlineAt = deps.now() + PIPELINE_DEADLINE_MS;
  const settings = await deps.getSettings();
  const recipient = settings.recipientTelegramId;
  const kind = trigger.kind;
  const ai = { assisted: false, providers: new Set() };
  const aiFields = () => ({
    aiAssisted: ai.assisted, aiProvider: [...ai.providers].join(', ').slice(0, 120) || null,
  });

  // The recipient hears every failure but "not about the truck" and "switched off".
  const fail = async (code, status, extra = {}) => {
    const reason = reasonText(code, { kind, lookbackHours: settings.lookbackHours, ...extra.ctx });
    await deps.finishReport(reportId, { status, reason, ...extra.counts, ...aiFields() });
    await deps.tellRecipient({
      telegram,
      recipient,
      text: failureMessage({
        code, kind, chatTitle: group.group_name, markedBy, at: triggerAt,
        ctx: { lookbackHours: settings.lookbackHours, ...extra.ctx },
      }),
    });
    // A report that FAILED (not one that had nothing to send) is an error to
    // the run ledger, so a send or download that keeps failing is visible.
    return status === 'failed' ? { status, reason: code, error: reason } : { status, reason: code };
  };

  if (!settings.enabled || !recipient) {
    await deps.finishReport(reportId, {
      status: 'failed', reason: 'Truck Photos was switched off before the PDF was made.', ...aiFields(),
    });
    return { skipped: true, status: 'failed', reason: 'switched_off' };
  }

  // 1. Which photos.
  const anchor = await findAnchor({ message, chatId, triggerAt }, deps);
  const window = { trigger: { messageId: message.message_id, sentAt: triggerAt }, anchor, lookbackHours: settings.lookbackHours };
  const candidates = await deps.listPhotosSince(chatId, windowStart(window), undefined, windowEnd(window));
  const selection = selectPhotos({ photos: candidates, ...window });
  if (!selection.photos.length) {
    return fail(selection.alreadySent ? 'already_sent' : 'no_photos', 'no_photos');
  }
  // The reply's own photo, when Wenze first saw it with the reply: its album may be incomplete.
  const anchorNote = anchorSeenLate && anchor
    ? { kind: anchor.kind === 'video' ? 'video' : 'photo', sentAt: anchor.sentAt }
    : null;

  // 2. The words — only when they are more than the word itself.
  if (!trigger.bare) {
    const said = await deps.readHandover({ text: message.text ?? message.caption ?? '', kind });
    if (said.provider) { ai.assisted = true; ai.providers.add(said.provider); }
    if (said.verdict === 'no') {
      await deps.finishReport(reportId, {
        status: 'not_a_handover',
        reason: 'A model read the message as being about something other than the truck (a load, for example).',
        ...aiFields(),
      });
      return { status: 'not_a_handover' };
    }
    if (said.verdict === 'unavailable') return fail('ai_unavailable', 'unclear');
    if (said.verdict !== 'yes') return fail('unclear', 'unclear');
  }

  // 3. The photos, one at a time — at most MAX_PHOTOS_PER_REPORT, the latest.
  // Videos are never downloaded: only their small previews, for the videos page.
  const allPhotos = selection.photos.filter((p) => p.kind !== 'video');
  const videos = selection.photos.filter((p) => p.kind === 'video').slice(-MAX_VIDEOS_PER_REPORT);
  const chosen = allPhotos.slice(-MAX_PHOTOS_PER_REPORT);
  const omitted = allPhotos.length - chosen.length;
  const { ready, unreadable } = chosen.length
    ? await deps.preparePhotos(chosen, { telegram, deadlineAt })
    : { ready: [], unreadable: 0 };
  if (!ready.length && !videos.length) return fail('download_failed', 'failed');

  // 4. A model sorts the photos and may only LEAVE OUT one it is sure is not
  // the truck. Videos are not judged.
  const sorted = ready.length
    ? await deps.sortPhotos(ready.map((r) => r.jpeg), { deadlineAt })
    : { verdicts: [], answered: 0, providers: [], stopped: null };
  if (sorted.answered) { ai.assisted = true; sorted.providers.forEach((p) => ai.providers.add(p)); }
  const plan = planPages({ ready, verdicts: sorted.verdicts, maxPerPdf: settings.maxPhotosPerPdf });
  const excludedCount = plan.leftOut.length;
  if (!plan.truck.length && !plan.forms.length && !videos.length) {
    return fail('all_excluded', 'no_photos', { ctx: { photoCount: ready.length }, counts: { excludedCount } });
  }
  const thumbs = videos.length ? await deps.prepareThumbnails(videos, { telegram, deadlineAt }) : [];
  const videoPages = videos.map((video, i) => ({
    ...videoEntry({
      number: i + 1, total: videos.length, sentAt: video.sentAt, fromName: video.fromName,
      durationSeconds: video.durationSeconds, chatId, messageId: video.messageId,
    }),
    thumb: thumbs[i] || null,
  }));

  // 5. The PDFs. The videos page is in part 1; the hand-over form closes the last part.
  const outbound = kind === 'inbound' ? await deps.lastSentOutbound(group.id, triggerAt) : null;
  const truckDecision = await decideTruck({ profile, group }, deps);
  const counts = {
    photoCount: plan.truck.length + plan.forms.length, excludedCount, parts: plan.parts.length, videoCount: videos.length,
  };
  const out = await sendReportParts({
    plan,
    videos,
    videoPages,
    cover: {
      kind, profile, groupName: group.group_name, triggerAt, markedBy, truckDecision, outbound, anchorNote,
      unreadableCount: unreadable, omittedCount: omitted, checkedTotal: ready.length,
    },
    to: { telegram, recipient },
  }, deps);
  if (out.failure) {
    const ctx = out.failure.code === 'too_large' ? undefined : { part: out.failure.part, parts: out.failure.parts };
    return finishPartial(fail(out.failure.code, 'failed', { counts, ctx }), out.delivered, reportId, deps);
  }
  const { delivered } = out;

  // 6. Delivered: the 👍 first — it is what the group sees — then the records.
  // A record that cannot be written now must not turn a delivered PDF into a
  // "failed" one, so it is not left to the catch-all below.
  await deps.reactDelivered({ telegram, chatId, messageId: message.message_id });
  if (plan.unchecked) {
    await deps.tellOwnerUnchecked({
      reportId, kind, chatTitle: group.group_name, unchecked: plan.unchecked, total: ready.length,
      stopped: sorted.stopped, groupId: group.id,
    });
  }
  const summary = {
    status: 'sent', photos: plan.truck.length + plan.forms.length, excluded: excludedCount, parts: plan.parts.length,
  };
  try {
    await deps.markPhotosInReport(delivered.map((item) => item.photo.id), reportId);
    await deps.finishReport(reportId, {
      status: 'sent',
      reason: [
        unreadable ? `${unreadable} photo(s) could not be downloaded from Telegram.` : null,
        plan.unchecked ? `${plan.unchecked} photo(s) were not checked by AI and went in unchecked.` : null,
        omitted ? `${omitted} earlier photo(s) were left out (at most ${MAX_PHOTOS_PER_REPORT}).` : null,
        anchorNote
          ? `The ${anchorNote.kind} replied to was sent ${chicagoTime(anchorNote.sentAt)}, before Wenze saw it; photos sent with it may be missing.`
          : null,
      ].filter(Boolean).join(' ') || null,
      ...counts,
      ...aiFields(),
      sent: true,
    });
  } catch (err) {
    console.error('[TRUCK PHOTOS] a PDF was delivered but its record was not written:', err?.message || String(err));
    return { ...summary, error: 'delivered, but the record could not be written' };
  }
  return summary;
}

/**
 * The truck number for the cover: the chat title's, checked against the
 * profile and the Dispatcher Board (lib/truckPhotos/truckNumber.js). A board
 * that cannot be read is checked against nothing — never a failed report.
 */
async function decideTruck({ profile, group }, deps) {
  let boardTrucks = [];
  try {
    boardTrucks = boardTrucksNaming(await deps.readBoardTrucks(), profile);
  } catch (err) {
    console.warn('[TRUCK PHOTOS] could not read the Dispatcher Board for the truck number:', err?.message || String(err));
  }
  return decideTruckNumber({
    profileUnit: profile?.unit_number ?? null,
    titleUnit: extractUnitFromGroupName(group?.group_name || ''),
    boardTrucks,
  });
}

/** A failure after some parts went out: those photos are still marked as sent. */
async function finishPartial(failing, delivered, reportId, deps) {
  const summary = await failing;
  if (delivered.length) await deps.markPhotosInReport(delivered.map((item) => item.photo.id), reportId);
  return summary;
}

/**
 * The report, recorded in the run ledger. An unexpected error finishes the
 * claim as `failed` and tells the recipient, so no claim is left pending.
 */
async function runTruckPhotoReport(job, deps = defaultDeps()) {
  // eslint-disable-next-line global-require
  const { withRunRecord } = deps.runLedger || require('../operations/runLedger');
  return withRunRecord('truck_photo_reports', async () => {
    try {
      return await produceReport(job, deps);
    } catch (err) {
      console.error('[TRUCK PHOTOS] the report failed:', err?.message || String(err));
      const settings = await deps.getSettings().catch(() => ({}));
      const finished = await deps.finishReport(job.reportId, {
        status: 'failed', reason: reasonText('unknown'), aiAssisted: false,
      }).catch(() => false);
      if (finished) {
        await deps.tellRecipient({
          telegram: job.telegram,
          recipient: settings.recipientTelegramId,
          text: failureMessage({
            code: 'unknown', kind: job.trigger.kind, chatTitle: job.group?.group_name,
            markedBy: senderName(job.message?.from), at: new Date((job.message?.date || 0) * 1000),
          }),
        });
      }
      return { error: err?.message || String(err) };
    }
  });
}

module.exports = {
  PIPELINE_DEADLINE_MS, MAX_PDF_BYTES, MAX_PHOTOS_PER_REPORT, MAX_VIDEOS_PER_REPORT, produceReport, runTruckPhotoReport,
};
