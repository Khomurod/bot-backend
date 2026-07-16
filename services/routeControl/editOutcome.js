/**
 * PURE outcome construction for an in-place Telegram edit: the stable `code`,
 * the structured `status`, the persisted screenshot-delivery truth, and the
 * admin-facing wording.
 *
 * Kept separate from telegramMessageEditor so the Admin contract (codes,
 * statuses, sentences) is unit-tested without any Telegram plumbing. Every
 * sentence here is self-contained — callers must NOT append their own "no new
 * message" wording.
 */

/**
 * What the admin list should persist about the screenshot's delivery truth.
 * @returns {string|null}
 */
function deriveScreenshotSendError({
  hasScreenshot, screenshotUpdated, hasPhotoMessage, editError, captionTooLongForConversion,
}) {
  if (hasScreenshot && screenshotUpdated) return null; // now shown
  if (hasScreenshot && hasPhotoMessage && editError) return editError;
  if (hasScreenshot && !hasPhotoMessage && captionTooLongForConversion) {
    return 'CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION';
  }
  if (hasScreenshot && !hasPhotoMessage && editError) return editError;
  if (hasScreenshot && !hasPhotoMessage) return 'SCREENSHOT_NOT_SHOWN_IN_TELEGRAM';
  if (!hasScreenshot && hasPhotoMessage) return 'SCREENSHOT_STILL_SHOWN_IN_TELEGRAM';
  return null;
}

/** The stable machine-readable result code for the edit. */
function deriveEditCode({
  captionTooLongForConversion, telegramChanged, editError, limitations, alreadyUpToDate,
}) {
  if (captionTooLongForConversion && !telegramChanged) return 'CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION';
  if (editError && !telegramChanged) return editError;
  if (limitations.some((l) => !l.startsWith('SCREENSHOT_DB_READ_FAILED')) && !telegramChanged) return 'NOT_UPDATED';
  if (limitations.length) return 'PARTIAL';
  if (alreadyUpToDate) return 'NO_CHANGE';
  if (telegramChanged) return 'UPDATED';
  return 'NO_CHANGE';
}

/**
 * The structured Admin status. An AMBIGUOUS transport outcome becomes
 * 'unconfirmed' — never a proven failure.
 */
function deriveEditStatus({
  alreadyUpToDate, telegramChanged, editError, limitations, captionTooLongForConversion,
  classification, code,
}) {
  if (alreadyUpToDate) return 'no_change';
  if (telegramChanged && !editError) return limitations.length ? 'partial' : 'updated';
  if (telegramChanged && editError) return 'partial';
  if (captionTooLongForConversion) return 'caption_too_long';
  if (classification) return classification.ambiguousOutcome ? 'unconfirmed' : 'failed';
  if (code === 'PARTIAL' || code === 'NOT_UPDATED') return 'partial';
  return 'no_change';
}

/** PURE. Short admin-facing summary of an in-place edit outcome. */
function describeEditOutcome({
  code, textUpdated, screenshotUpdated, hasScreenshot, limitations, editError, converted,
  classification = null, attempts = 0, alreadyUpToDate = false,
}) {
  // First-attempt "message is not modified": nothing was changed — say so,
  // never claim an update happened.
  if (alreadyUpToDate) {
    return 'The Telegram message was already up to date — nothing needed changing, and no new message was sent.';
  }
  if (code === 'UPDATED') {
    if (converted) {
      return 'The existing Telegram message was converted to a photo and updated in place — no new message was sent.';
    }
    const parts = [];
    if (screenshotUpdated) parts.push('screenshot');
    if (textUpdated) parts.push('message text');
    return `Updated the existing Telegram ${parts.join(' and ') || 'message'} in place — no new message was sent.`;
  }
  if (code === 'CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION') {
    return 'The screenshot is stored, but the full route text is too long to fit in a photo caption, so the existing '
      + 'text message was left unchanged (converting it would drop part of the route). Use “Send as new message” to post it as a photo. No new message was sent.';
  }
  if (code === 'PARTIAL') {
    const notes = [];
    if (limitations.includes('PHOTO_IMAGE_CANNOT_BE_REMOVED_IN_PLACE')) {
      notes.push('the screenshot was removed from storage, but Telegram can’t remove the image from the already-sent photo message');
    }
    if (limitations.some((l) => l.startsWith('SCREENSHOT_UPDATE_FAILED'))
        || limitations.some((l) => l.startsWith('TEXT_UPDATE_FAILED'))
        || limitations.some((l) => l.startsWith('SCREENSHOT_CONVERT_FAILED'))) {
      notes.push('part of the Telegram update failed');
    }
    return `Updated what Telegram allows${notes.length ? ` — ${notes.join('; ')}` : ''}. No new message was sent.`;
  }
  // Transport-level failures carry a classification. An AMBIGUOUS outcome (the
  // connection dropped mid-request) is reported as unconfirmed — never as a
  // proven Telegram rejection.
  if (classification && classification.category === 'transport') {
    if (classification.ambiguousOutcome) {
      const base = classification.code === 'TELEGRAM_TIMEOUT'
        ? 'Telegram did not respond in time while receiving the request'
        : 'Telegram’s connection closed while it was receiving the image';
      return `${base}. The update could not be confirmed after ${attempts} attempt${attempts === 1 ? '' : 's'}. No new message was sent.`;
    }
    return `${classification.description} The update was not applied after ${attempts} attempt${attempts === 1 ? '' : 's'}. No new message was sent.`;
  }
  if (classification && classification.code === 'TELEGRAM_RATE_LIMITED') {
    return `Telegram temporarily rate-limited the update; automatic retries were attempted (${attempts}). No new message was sent.`;
  }
  if (classification && classification.code === 'TELEGRAM_SERVICE_ERROR') {
    return `Telegram had a temporary server error and the update could not be applied after ${attempts} attempts. No new message was sent.`;
  }
  if (code === 'BOT_PERMISSION') {
    return 'Telegram rejected the update because the bot does not have permission to edit the message in that group. No new message was sent.';
  }
  if (code === 'MESSAGE_NOT_FOUND') {
    return 'The original Telegram message could not be found — verify it was not deleted. No new message was sent.';
  }
  if (code === 'MESSAGE_NOT_EDITABLE') {
    return 'Telegram will not allow the existing message to be edited. No new message was sent.';
  }
  if (code === 'NOT_UPDATED' || code === 'NO_CHANGE') {
    if (limitations.includes('PHOTO_IMAGE_CANNOT_BE_REMOVED_IN_PLACE')) {
      return 'The screenshot was removed from storage, but Telegram cannot remove the image from the already-sent photo message. No new message was sent.';
    }
    return 'Nothing needed updating in Telegram.';
  }
  return `Telegram could not be updated (${(classification && classification.description) || editError || code}). The stored route was updated; no new message was sent.`;
}

module.exports = {
  deriveScreenshotSendError,
  deriveEditCode,
  deriveEditStatus,
  describeEditOutcome,
};
