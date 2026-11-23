'use strict';

/**
 * The one Yes / No a PDF correction asks (the owner, 23 November 2026: "rebuild
 * the PDF at once; ask Yes / No only when the truck number in the driver's
 * profile changes, because the map and /location read the profile").
 *
 * A person corrected the truck number on a PDF and the profile says another:
 * Wenze asks whether the profile should say it too. Yes applies
 * `profile.set_unit` through the correction registry, as that person
 * (`telegram:<id>`, audited, revertible in Operations → History), and the
 * action refuses when the profile no longer says what the question showed.
 * No changes nothing.
 *
 * THE BUTTON CARRIES THE QUESTION: `tpu:<y|n>:<report>:<from>:<to>`. A press
 * is honoured only from the recipient or a listed corrector, and only while
 * the report's latest correction still names that number — a button under an
 * older correction changes nothing.
 */

const { mayCorrect } = require('../../lib/truckPhotos/whoMayMark');
const { profileQuestionText, profileDoneText, profileKeptText } = require('../../lib/truckPhotos/correctionText');
const { extractUnitFromGroupName } = require('../../lib/drivers/driverGroupTitle');
const { sameUnitNumber } = require('../../lib/drivers/unitNumber');

const CALLBACK_PATTERN = /^tpu:[yn]:\d{1,12}:[A-Za-z0-9-]{1,12}:[0-9]{1,6}[A-Z]?$/;
const NONE = '-';
const SAFE_UNIT = /^[A-Za-z0-9]{1,12}$/;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    getSettings: require('../../database/truckPhotos/settings').getTruckPhotoSettings,
    getReport: require('../../database/truckPhotos/corrections').getReport,
    readDriverContext: require('../../database/truckPhotos/driverContext').readDriverContext,
    applyCorrection: require('../operations/corrections/apply').applyCorrection,
  };
  /* eslint-enable global-require */
}

/**
 * Should a corrected number be asked about, and with which button data?
 * Null when the profile already says it, or its number cannot be carried.
 */
function profileQuestionFor({ reportId, profile, to }) {
  const from = String(profile?.unit_number ?? '').trim();
  if (!to || sameUnitNumber(from, to)) return null;
  if (from && !SAFE_UNIT.test(from)) return null;
  const carried = from || NONE;
  return {
    from: from || null,
    keyboard: {
      inline_keyboard: [[
        { text: 'Yes, change the profile', callback_data: `tpu:y:${reportId}:${carried}:${to}` },
        { text: 'No, leave it', callback_data: `tpu:n:${reportId}:${carried}:${to}` },
      ]],
    },
  };
}

/** The question's words for one chat. */
function questionText({ chatTitle, from, to }) {
  return profileQuestionText({ chatTitle, from, to });
}

/**
 * A press of Yes or No.
 *
 * @returns {Promise<{text: string, alert?: boolean, edit?: string}>}
 *   `text` answers the press; `edit` replaces the question (its buttons go)
 */
async function handleProfileButton({ data, telegramUserId }, deps = defaultDeps()) {
  if (!CALLBACK_PATTERN.test(String(data || ''))) return { text: 'Not a button I know.', alert: true };
  const [, answer, reportId, fromRaw, to] = String(data).split(':');
  const from = fromRaw === NONE ? null : fromRaw;
  const settings = await deps.getSettings();
  if (!mayCorrect({ userId: telegramUserId, recipientId: settings.recipientTelegramId, editorIds: settings.editorTelegramIds })) {
    return { text: 'Only the person who receives the PDFs, or someone listed in Settings → Truck Photos, can answer.', alert: true };
  }
  const report = await deps.getReport(Number(reportId));
  if (!report || !report.groupId) return { text: 'That hand-over is no longer on record.', alert: true, edit: 'Nothing changed: the hand-over is no longer on record.' };
  if (!sameUnitNumber(report.edits?.unit, to)) {
    return { text: 'The PDF was corrected again since, so nothing changed.', alert: true, edit: 'Nothing changed: the PDF was corrected again since this question.' };
  }
  if (answer === 'n') return { text: 'Left as it is.', edit: profileKeptText({ from }) };
  try {
    await deps.applyCorrection({
      actionKey: 'profile.set_unit',
      payload: { groupId: report.groupId, unitNumber: to, from },
      admin: { telegramUserId: String(telegramUserId) },
      reason: 'Confirmed under a corrected Truck Photos PDF.',
      markFinding: false,
    });
  } catch (err) {
    const why = String(err?.message || 'it could not be applied').slice(0, 200);
    return { text: 'Nothing changed.', alert: true, edit: `Nothing changed: ${why}` };
  }
  return {
    text: 'Done.',
    edit: profileDoneText({ chatTitle: report.groupName, to, titleUnit: extractUnitFromGroupName(report.groupName || '') }),
  };
}

module.exports = {
  CALLBACK_PATTERN, profileQuestionFor, questionText, handleProfileButton,
};
