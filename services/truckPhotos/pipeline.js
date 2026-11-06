'use strict';

/**
 * Making one hand-over's PDF, from a claimed `outbound` / `inbound` message to
 * the recipient's chat. Runs after the claim and the settle delay
 * (services/truckPhotos/triggerHandler.js), one report at a time.
 *
 *   1. which photos   lib/truckPhotos/selectPhotos.js — the reply's album and
 *                     its neighbours, or the last `lookback_hours`; never one
 *                     already in a PDF, never one sent after the word
 *   2. the words      a message that is more than the bare word is checked by a
 *                     model (aiCheck.readHandover); "not about the truck" is
 *                     recorded and nothing is sent; "could not tell" — or no
 *                     model — is no PDF and the recipient is told, never a guess
 *   3. the photos     downloaded one at a time (pdf.preparePhotos)
 *   4. the filter     a model may leave out a photo that is clearly not the
 *                     truck (aiCheck.filterPhotos) — only leave out; with no
 *                     model every photo stays
 *   5. the PDFs       parts of `max_photos_per_pdf` (60), each with a cover; an
 *                     inbound cover names the last outbound
 *   6. delivery       to the recipient; then 👍 on the word; then the photos
 *                     are marked as sent and the report finished
 *
 * WHEN NO PDF CAN BE MADE the recipient is told privately, in fixed words
 * (lib/truckPhotos/failureText.js). NOTHING IS EVER WRITTEN IN THE DRIVER'S
 * GROUP. `ai_assisted` records whether a model's answer shaped the report.
 */

const { selectPhotos, windowStart } = require('../../lib/truckPhotos/selectPhotos');
const { chunk } = require('../../lib/truckPhotos/chunk');
const {
  coverLines, photoCaption, fileName, deliveryCaption, truckOf,
} = require('../../lib/truckPhotos/pdfLayout');
const { reasonText, failureMessage } = require('../../lib/truckPhotos/failureText');
const { senderName, replyTarget } = require('../../lib/telegram/messageParts');
const { hasPicture } = require('./capture');

/**
 * Downloads and model calls stop here (what was not reached is counted, or
 * kept unfiltered); each send has its own three minutes. A report still
 * running is never closed by the hourly sweep — it skips the reports this
 * process has queued (triggerHandler.activeReportIds).
 */
const PIPELINE_DEADLINE_MS = 12 * 60 * 1000;
/** Telegram takes a document of up to 50 MB from a bot. */
const MAX_PDF_BYTES = 49 * 1024 * 1024;
/**
 * Four PDFs' worth. Every photo is held in memory (re-encoded) until its PDF is
 * sent, so a reply to a days-old photo cannot pull hundreds in; the ones
 * closest to the word are kept, and the cover says how many were left out.
 */
const MAX_PHOTOS_PER_REPORT = 240;

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
    filterPhotos: ai.filterPhotos,
    preparePhotos: pdf.preparePhotos,
    buildPdf: pdf.buildPdf,
    sendPdf: deliver.sendPdf,
    reactDelivered: deliver.reactDelivered,
    tellRecipient: deliver.tellRecipient,
    now: () => Date.now(),
  };
  /* eslint-enable global-require */
}

/** The photo this word is about: itself when it carries one, else the photo it replies to. */
async function findAnchor({ message, chatId, triggerAt }, deps) {
  if (hasPicture(message)) {
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
  const { reportId, message, trigger, group, profile = null, telegram } = job;
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
  const candidates = await deps.listPhotosSince(chatId, windowStart(window));
  const selection = selectPhotos({ photos: candidates, ...window });
  if (!selection.photos.length) {
    return fail(selection.alreadySent ? 'already_sent' : 'no_photos', 'no_photos');
  }

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
  const chosen = selection.photos.slice(-MAX_PHOTOS_PER_REPORT);
  const omitted = selection.photos.length - chosen.length;
  const { ready, unreadable } = await deps.preparePhotos(chosen, { telegram, deadlineAt });
  if (!ready.length) return fail('download_failed', 'failed');

  // 4. A model may only LEAVE OUT a photo that is clearly not the truck.
  const filter = await deps.filterPhotos(ready.map((r) => r.jpeg), { deadlineAt });
  if (filter.answered) { ai.assisted = true; filter.providers.forEach((p) => ai.providers.add(p)); }
  const kept = ready.filter((_, i) => !filter.excluded.has(i));
  const excludedCount = ready.length - kept.length;
  if (!kept.length) {
    return fail('all_excluded', 'no_photos', { ctx: { photoCount: ready.length }, counts: { excludedCount } });
  }

  // 5. The PDFs.
  const outbound = kind === 'inbound' ? await deps.lastSentOutbound(group.id, triggerAt) : null;
  const parts = chunk(kept, settings.maxPhotosPerPdf);
  const unit = truckOf(profile, group.group_name).unit;
  const counts = { photoCount: kept.length, excludedCount, parts: parts.length };
  const delivered = [];
  for (let p = 0; p < parts.length; p += 1) {
    const first = delivered.length + 1;
    const pageOf = (item, i) => ({
      jpeg: item.jpeg,
      width: item.width,
      height: item.height,
      caption: photoCaption({
        number: first + i, total: kept.length, sentAt: item.photo.sentAt, fromName: item.photo.fromName,
      }),
    });
    const shared = {
      kind, profile, groupName: group.group_name, triggerAt, photoCount: kept.length, excludedCount,
      part: p + 1, parts: parts.length, outbound,
    };
    // eslint-disable-next-line no-await-in-loop
    const buffer = await deps.buildPdf({
      title: `${kind} ${unit || ''}`.trim(),
      coverLines: coverLines({
        ...shared, markedBy, unreadableCount: unreadable, omittedCount: omitted,
        firstNumber: first, lastNumber: first + parts[p].length - 1,
      }),
      pages: parts[p].map(pageOf),
    });
    if (buffer.length > MAX_PDF_BYTES) {
      return finishPartial(fail('too_large', 'failed', { counts }), delivered, reportId, deps);
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await deps.sendPdf({
        telegram,
        recipient,
        buffer,
        fileName: fileName({ kind, unit, at: triggerAt, part: p + 1, parts: parts.length }),
        caption: deliveryCaption(shared),
      });
    } catch (err) {
      console.warn('[TRUCK PHOTOS] a PDF was not delivered:', err?.response?.error_code || err?.name || 'error');
      const code = p === 0 ? 'not_delivered' : 'part_not_delivered';
      return finishPartial(
        fail(code, 'failed', { counts, ctx: { part: p + 1, parts: parts.length } }), delivered, reportId, deps,
      );
    }
    delivered.push(...parts[p]);
  }

  // 6. Delivered: the 👍 first — it is what the group sees — then the records.
  // A record that cannot be written now must not turn a delivered PDF into a
  // "failed" one, so it is not left to the catch-all below.
  await deps.reactDelivered({ telegram, chatId, messageId: message.message_id });
  const summary = { status: 'sent', photos: kept.length, excluded: excludedCount, parts: parts.length };
  try {
    await deps.markPhotosInReport(delivered.map((item) => item.photo.id), reportId);
    await deps.finishReport(reportId, {
      status: 'sent',
      reason: [
        unreadable ? `${unreadable} photo(s) could not be downloaded from Telegram.` : null,
        omitted ? `${omitted} earlier photo(s) were left out (at most ${MAX_PHOTOS_PER_REPORT}).` : null,
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
  PIPELINE_DEADLINE_MS, MAX_PDF_BYTES, MAX_PHOTOS_PER_REPORT, produceReport, runTruckPhotoReport,
};
