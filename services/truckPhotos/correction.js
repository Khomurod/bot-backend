'use strict';

/**
 * A person answers a hand-over PDF, and Wenze rebuilds it (the owner,
 * 23 November 2026). Two ways in:
 *
 *   PRIVATE   a reply, in a private chat with the bot, to one of its Truck
 *             Photos messages there: a PDF, a failure message, or its own
 *             question back (`truck_photo_report_messages`). Consumed — the
 *             anonymous-feedback prompt in the same chat never sees it.
 *   GROUP     a reply in the driver group to the `outbound` / `inbound` word,
 *             tagging the bot. Answered with REACTIONS ONLY (👀, then 👍 or 🤷):
 *             nothing is ever written in the group. Words go privately to the
 *             person (if they ever pressed Start), the PDF to the recipient.
 *
 * WHO: the recipient, and the people listed in Settings → Truck Photos
 * (lib/truckPhotos/whoMayMark.js `mayCorrect`). Anybody else: privately told
 * so; in a group, ignored.
 *
 * WHAT: a model reads the answer into actions from a closed list
 * (services/truckPhotos/correctionRead.js, lib/truckPhotos/correctionActions.js);
 * anything not understood is asked back, never partly done. The PDF is then
 * rebuilt and sent at once (services/truckPhotos/rebuild.js). Only a new truck
 * number that the PROFILE does not say asks Yes / No — about the profile
 * (services/truckPhotos/profileQuestion.js).
 *
 * NEVER THROWS at the bot. The rebuild runs in the reports' queue, one at a time.
 */

const { mayCorrect } = require('../../lib/truckPhotos/whoMayMark');
const { labelItems, applyActions } = require('../../lib/truckPhotos/correctionActions');
const {
  TEXT, unclearText, failedText, cancelledText,
} = require('../../lib/truckPhotos/correctionText');
const { profileQuestionFor, questionText } = require('./profileQuestion');
const { truckForCover } = require('./truckForCover');

const REACT = Object.freeze({ accepted: '👀', done: '👍', needsPerson: '🤷' });

function defaultDeps() {
  /* eslint-disable global-require */
  const corrections = require('../../database/truckPhotos/corrections');
  const photos = require('../../database/truckPhotos/photos');
  const pdf = require('./pdf');
  const deliver = require('./deliver');
  const ai = require('./aiCheck');
  return {
    ...corrections,
    getSettings: require('../../database/truckPhotos/settings').getTruckPhotoSettings,
    readDriverContext: require('../../database/truckPhotos/driverContext').readDriverContext,
    readBoardTrucks: require('../../database/truckPhotos/boardTrucks').readPresentBoardTrucks,
    lastSentOutbound: require('../../database/truckPhotos/reports').lastSentOutbound,
    listPhotosSince: photos.listPhotosSince,
    readCorrection: require('./correctionRead').readCorrection,
    sortPhotos: ai.sortPhotos,
    preparePhotos: pdf.preparePhotos,
    prepareThumbnails: pdf.prepareThumbnails,
    buildPdf: pdf.buildPdf,
    sendPdf: deliver.sendPdf,
    tellRecipient: deliver.tellRecipient,
    clearReaction: deliver.clearReaction,
    reactDelivered: deliver.reactDelivered,
    react: require('../telegram/reaction').reactQuietly,
    tellOwnerUnchecked: require('./uncheckedNotice').tellOwnerUnchecked,
    rebuild: require('./rebuild'),
    queue: require('./triggerHandler').queueTruckPhotoJob,
  };
  /* eslint-enable global-require */
}

/**
 * Take up a possible correction.
 *
 * @param {object} req
 * @param {'private'|'group'} req.source
 * @param {string|number} req.chatId        where the person wrote
 * @param {number} req.messageId            their message
 * @param {number} req.replyToMessageId     the message they answered
 * @param {string} req.text                 their words (the bot's tag already taken out)
 * @param {string|number} req.fromId
 * @param {string|null} req.fromName
 * @param {object} req.telegram
 * @returns {Promise<{handled: boolean, done?: Promise}>}
 *   `handled` false: not a Truck Photos correction — the message goes on as before
 */
async function takeCorrection(req, deps = defaultDeps()) {
  try {
    const found = req.source === 'private'
      ? await deps.findByMessage(req.chatId, req.replyToMessageId)
      : await deps.findByTrigger(req.chatId, req.replyToMessageId).then((report) => (report ? { report } : null));
    if (!found?.report) return { handled: false };
    const settings = await deps.getSettings();
    const reply = answerer(req, deps);
    if (!settings.enabled || !settings.recipientTelegramId) {
      if (req.source === 'group') return { handled: false };
      await reply(TEXT.switchedOff);
      return { handled: true };
    }
    if (!mayCorrect({ userId: req.fromId, recipientId: settings.recipientTelegramId, editorIds: settings.editorTelegramIds })) {
      if (req.source === 'group') return { handled: false };
      await reply(TEXT.notAllowed);
      return { handled: true };
    }
    if (!String(req.text || '').trim()) {
      await reply(TEXT.empty, { report: found.report });
      return { handled: true };
    }
    await deps.react(req.telegram, req.chatId, req.messageId, REACT.accepted, 'TRUCK PHOTOS');
    // The version the person SAW: "photo 11" means photo 11 of the PDF they answered.
    const seenVersion = found.version || found.report.version;
    const done = deps.queue(() => runCorrection({
      ...req, reportId: found.report.id, seenVersion, settings,
    }, deps));
    return { handled: true, done };
  } catch (err) {
    console.error('[TRUCK PHOTOS] could not take up a correction:', err?.message || String(err));
    return { handled: false };
  }
}

/**
 * How Wenze answers this person in words: in the private chat, under their
 * message; from a group, privately (never in the group). Each answer is
 * remembered as part 0 of the report, so a reply to it is a correction too.
 */
function answerer(req, deps) {
  return async (text, { report = null, replyMarkup = null } = {}) => {
    const to = req.source === 'private' ? req.chatId : req.fromId;
    const sent = await deps.tellRecipient({
      telegram: req.telegram,
      recipient: to,
      text,
      replyTo: req.source === 'private' ? req.messageId : null,
      replyMarkup,
    });
    if (report && Number.isInteger(sent)) {
      await deps.recordMessages({ reportId: report.id, version: report.version, messages: [{ chatId: to, messageId: sent, part: 0 }] })
        .catch(() => {});
    }
    return sent;
  };
}

/** The correction itself, in the queue. Never throws. */
async function runCorrection(req, deps = defaultDeps()) {
  const reply = answerer(req, deps);
  const finish = (emoji) => deps.react(req.telegram, req.chatId, req.messageId, emoji, 'TRUCK PHOTOS');
  try {
    const report = await deps.getReport(req.reportId);
    if (!report) { await reply(TEXT.no_photos); await finish(REACT.needsPerson); return { status: 'gone' }; }
    const items = await deps.listItems(report.id, report.version);
    // Labels from the PDF the person answered; the rebuild starts from the newest.
    const seen = req.seenVersion && req.seenVersion !== report.version ? await deps.listItems(report.id, req.seenVersion) : items;
    const labels = labelItems(seen);
    const driver = report.groupId ? await deps.readDriverContext(report.groupId).catch(() => ({ profile: null })) : { profile: null };
    const shown = await truckForCover({ profile: driver.profile, groupName: report.groupName, edits: report.edits }, deps);

    const read = await deps.readCorrection({
      text: req.text, labels, pdf: { kind: report.kind, unit: shown.unit, chatTitle: report.groupName },
    });
    if (read.status === 'unavailable') {
      await reply(TEXT.unavailable, { report });
      await finish(REACT.needsPerson);
      return { status: 'unavailable' };
    }
    if (read.status !== 'ok') {
      await reply(unclearText(read.question), { report });
      await finish(REACT.needsPerson);
      return { status: 'unclear' };
    }

    const applied = applyActions(report.edits, read.actions, { labels, kind: report.kind, shownUnit: shown.unit });
    if (read.actions.some((a) => a.do === 'truck_number')) applied.edits.unitBy = req.fromName || null;
    if (applied.cancel) {
      const out = await deps.rebuild.cancelReport({
        report, edits: applied.edits, byName: req.fromName, telegram: req.telegram,
      }, deps);
      await reply(out.status === 'cancelled' ? cancelledText({ kind: report.kind, chatTitle: report.groupName }) : TEXT.raced);
      await finish(out.status === 'cancelled' ? REACT.done : REACT.needsPerson);
      return { status: out.status };
    }

    const inRecipientChat = req.source === 'private' && String(req.chatId) === String(req.settings.recipientTelegramId);
    const replyTo = inRecipientChat ? req.messageId : await deps.latestPdfMessage(report.id, req.settings.recipientTelegramId);
    const out = await deps.rebuild.rebuildReport({
      report,
      items,
      edits: applied.edits,
      kind: applied.kind,
      recheck: applied.recheck,
      correction: { byName: req.fromName, summary: applied.summary },
      profile: driver.profile,
      settings: req.settings,
      replyTo,
      telegram: req.telegram,
    }, deps);
    if (out.status !== 'sent') {
      await reply(out.status === 'failed' ? failedText(out.failure) : (TEXT[out.status] || TEXT.error), { report });
      await finish(REACT.needsPerson);
      return { status: out.status };
    }
    if (!inRecipientChat && req.source === 'private') await reply(TEXT.sentElsewhere);
    await finish(REACT.done);
    await askAboutProfile({
      req, report, profile: driver.profile, edits: applied.edits, asked: read.actions.some((a) => a.do === 'truck_number'),
    }, deps);
    return { status: 'sent', version: out.version };
  } catch (err) {
    console.error('[TRUCK PHOTOS] a correction failed:', err?.message || String(err));
    await reply(TEXT.error).catch(() => {});
    await finish(REACT.needsPerson).catch(() => {});
    return { status: 'error' };
  }
}

/**
 * A new truck number the profile does not say: ask the person (privately)
 * whether the profile should say it too. Someone who never pressed Start
 * cannot be asked, so the recipient is asked instead.
 */
async function askAboutProfile({
  req, report, profile, edits, asked,
}, deps) {
  if (!asked || !report.groupId) return;
  const question = profileQuestionFor({ reportId: report.id, profile, to: edits.unit });
  if (!question) return;
  const text = questionText({ chatTitle: report.groupName, from: question.from, to: edits.unit });
  const to = req.source === 'private' ? req.chatId : req.fromId;
  const sent = await deps.tellRecipient({ telegram: req.telegram, recipient: to, text, replyMarkup: question.keyboard });
  if (!sent && String(to) !== String(req.settings.recipientTelegramId)) {
    await deps.tellRecipient({
      telegram: req.telegram, recipient: req.settings.recipientTelegramId, text, replyMarkup: question.keyboard,
    });
  }
}

module.exports = {
  REACT, takeCorrection, runCorrection,
};
