'use strict';

/**
 * Rebuilding a hand-over PDF after a person's correction, and sending it again
 * at once (the owner, 23 November 2026: "rebuild it right away, that breaks
 * nothing"). Runs in the same one-at-a-time queue as the reports
 * (services/truckPhotos/triggerHandler.js).
 *
 *   1. which photos   the time a person named (`edits.window`), else what the
 *                     last version held, else the time the photos were first
 *                     chosen from; never a photo another report already sent
 *                     (the old rule: never twice); the senders a person chose
 *   2. the photos     downloaded again — no PDF or photo is ever stored
 *   3. the sort       the last version's sort is reused; a photo nobody sorted
 *                     yet, or every photo on "look again" (`recheck`), is sorted
 *                     by a model; a person's removal or putting back outranks it
 *   4. the PDFs       to the RECIPIENT (the PDFs' one person), answering the
 *                     message that asked or the last PDF; the cover says
 *                     "CORRECTED - version N, asked by …" and what changed
 *   5. the record     the next version, what it held, which messages it became,
 *                     and the photos marked as this report's — those no longer
 *                     in it freed for the next word
 *
 * A CANCEL closes the report: its photos are freed and the 👍 on the word is
 * taken back. Nothing is ever written in the driver's group.
 */

const { planPages, versionItems } = require('../../lib/truckPhotos/pagePlan');
const { forcedPlace, bySenders } = require('../../lib/truckPhotos/correctionActions');
const { videoEntry } = require('../../lib/truckPhotos/pdfLayout');
const { sendReportParts } = require('./sendParts');
const { truckForCover } = require('./truckForCover');

const MAX_PHOTOS = 240;
const MAX_VIDEOS = 60;
const DEADLINE_MS = 12 * 60 * 1000;

const belongs = (photo, reportId) => photo.reportId === null || photo.reportId === undefined || photo.reportId === reportId;

/** The photos (and videos) this version is made from. */
async function candidatesFor({ report, edits, items }, deps) {
  if (edits.window?.from && edits.window?.until) {
    const listed = await deps.listPhotosSince(report.chatId, new Date(edits.window.from), undefined, new Date(edits.window.until));
    return listed.filter((p) => belongs(p, report.id));
  }
  if (items.length) return items.map((i) => i.photo);
  if (report.photosFrom && report.photosUntil) {
    const listed = await deps.listPhotosSince(report.chatId, new Date(report.photosFrom), undefined, new Date(report.photosUntil));
    return listed.filter((p) => belongs(p, report.id) && Number(p.messageId) <= report.triggerMessageId);
  }
  return [];
}

/**
 * @param {object} args
 * @param {object} args.report       database/truckPhotos/corrections.js `getReport`
 * @param {Array} args.items         the last version's items (`listItems`)
 * @param {object} args.edits        every correction so far (correctionActions.applyActions)
 * @param {string} args.kind         outbound | inbound, after the correction
 * @param {boolean} [args.recheck]   sort every photo again
 * @param {{byName: string|null, summary: string[]}} args.correction
 * @param {object|null} args.profile
 * @param {object} args.settings     Truck Photos settings (recipient, parts)
 * @param {number|null} [args.replyTo]  the message in the recipient's chat the PDF answers
 * @param {object} args.telegram
 * @returns {Promise<{status: string, version?: number, unit?: string|null, failure?: object}>}
 */
async function rebuildReport({
  report, items, edits, kind, recheck = false, correction, profile, settings, replyTo = null, telegram,
}, deps) {
  const deadlineAt = Date.now() + DEADLINE_MS;
  const version = report.version + 1;
  const all = bySenders(await candidatesFor({ report, edits, items }, deps), edits);
  const photos = all.filter((p) => p.kind !== 'video').slice(-MAX_PHOTOS);
  const videos = all.filter((p) => p.kind === 'video').slice(-MAX_VIDEOS);
  if (!photos.length && !videos.length) return { status: 'no_photos' };

  const { ready, unreadable } = photos.length
    ? await deps.preparePhotos(photos, { telegram, deadlineAt })
    : { ready: [], unreadable: 0 };
  if (!ready.length && !videos.length) return { status: 'download_failed' };

  // The last sort is reused unless a person asked to look again.
  const sortedBefore = new Map(recheck ? [] : items.filter((i) => i.verdict).map((i) => [i.photo.id, i.verdict]));
  const verdicts = ready.map((r) => sortedBefore.get(r.photo.id) || null);
  const toSort = verdicts.map((v, i) => (v ? null : i)).filter((i) => i !== null);
  let sorted = { answered: 0, providers: [], stopped: null };
  if (toSort.length) {
    sorted = await deps.sortPhotos(toSort.map((i) => ready[i].jpeg), { deadlineAt });
    toSort.forEach((at, j) => { verdicts[at] = sorted.verdicts[j] || null; });
  }
  const plan = planPages({
    ready, verdicts, maxPerPdf: settings.maxPhotosPerPdf, forced: (item, verdict) => forcedPlace(item.photo.id, verdict, edits),
  });
  if (!plan.truck.length && !plan.forms.length && !videos.length) return { status: 'all_excluded' };

  const thumbs = videos.length ? await deps.prepareThumbnails(videos, { telegram, deadlineAt }) : [];
  const videoPages = videos.map((video, i) => ({
    ...videoEntry({
      number: i + 1, total: videos.length, sentAt: video.sentAt, fromName: video.fromName,
      durationSeconds: video.durationSeconds, chatId: report.chatId, messageId: video.messageId,
    }),
    thumb: thumbs[i] || null,
  }));
  const truckDecision = await truckForCover({ profile, groupName: report.groupName, edits }, deps);
  const outbound = kind === 'inbound' ? await deps.lastSentOutbound(report.groupId, report.createdAt) : null;
  const out = await sendReportParts({
    plan,
    videos,
    videoPages,
    cover: {
      kind, profile, groupName: report.groupName, triggerAt: report.createdAt, markedBy: report.triggeredByName,
      truckDecision, outbound, anchorNote: null, unreadableCount: unreadable, omittedCount: 0,
      checkedTotal: ready.length, correction: { version, byName: correction.byName, summary: correction.summary },
    },
    to: { telegram, recipient: settings.recipientTelegramId, replyTo },
  }, deps);
  if (out.failure) return { status: 'failed', failure: out.failure };

  const saved = await deps.saveVersion(report.id, {
    fromVersion: report.version,
    kind,
    status: 'sent',
    edits,
    correctedByName: correction.byName,
    reason: plan.unchecked ? `${plan.unchecked} photo(s) were not checked by AI and went in unchecked.` : null,
    photoCount: plan.truck.length + plan.forms.length,
    excludedCount: plan.leftOut.length,
    parts: plan.parts.length,
    videoCount: videos.length,
    aiAssisted: sorted.answered > 0,
    aiProvider: sorted.providers.join(', ').slice(0, 120) || null,
  });
  if (saved) {
    await deps.recordVersion({
      reportId: report.id,
      version,
      items: versionItems(plan, videos),
      messages: out.messages.filter((m) => m.messageId)
        .map((m) => ({ chatId: settings.recipientTelegramId, messageId: m.messageId, part: m.part })),
    });
    await deps.setReportPhotos(report.id, out.delivered.map((d) => d.photo.id));
  }
  // A report that had no PDF before ("could not tell", nothing downloaded) now
  // has one: the word gets its 👍, as a first delivery would.
  if (report.status !== 'sent' && typeof deps.reactDelivered === 'function') {
    await deps.reactDelivered({ telegram, chatId: report.chatId, messageId: report.triggerMessageId });
  }
  if (plan.unchecked) {
    await deps.tellOwnerUnchecked({
      reportId: report.id, kind, chatTitle: report.groupName, unchecked: plan.unchecked, total: ready.length,
      stopped: sorted.stopped, groupId: report.groupId,
    });
  }
  return {
    status: 'sent', version, unit: truckDecision.unit, recorded: saved,
  };
}

/** "Not a hand-over at all": the report closes, its photos are free, and the 👍 is taken back. */
async function cancelReport({ report, edits, byName, telegram }, deps) {
  const saved = await deps.saveVersion(report.id, {
    fromVersion: report.version, kind: report.kind, status: 'cancelled', edits, correctedByName: byName,
    reason: `Cancelled by ${byName || 'a person'}: not a truck hand-over.`,
  });
  if (!saved) return { status: 'raced' };
  await deps.setReportPhotos(report.id, []);
  await deps.clearReaction({ telegram, chatId: report.chatId, messageId: report.triggerMessageId });
  return { status: 'cancelled' };
}

module.exports = { rebuildReport, cancelReport, candidatesFor };
