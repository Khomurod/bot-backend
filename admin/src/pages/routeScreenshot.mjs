/**
 * Pure, dependency-free helpers for the Route Control screenshot controls
 * (upload / drag-drop / Ctrl+V paste / replace / remove) shared by the "Assign
 * route" form AND the per-route screenshot section on existing routes.
 *
 * No React/DOM here so the client-side validation and the admin status wording
 * can be unit-tested under node:test (via dynamic import) — this repo has no
 * frontend test runner, so this mirrors routeControlGroupSearch.mjs.
 */

export const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const SCREENSHOT_MAX_MB = 8;

/**
 * PURE. Validate a chosen/dropped/pasted image before upload. Mirrors the
 * server's MIME + size checks so the admin gets an instant, clear reason.
 * @returns {{ ok:boolean, code:string, error:(string|null) }}
 */
export function validateScreenshotFile(file, { maxMb = SCREENSHOT_MAX_MB } = {}) {
  if (!file) {
    return { ok: false, code: 'NO_FILE', error: 'No image found. Choose a PNG, JPG or WEBP file.' };
  }
  const type = file.type || '';
  if (!SCREENSHOT_TYPES.includes(type)) {
    return { ok: false, code: 'BAD_TYPE', error: `Screenshot must be PNG, JPG or WEBP (got ${type || 'unknown type'}).` };
  }
  const size = Number(file.size) || 0;
  if (size <= 0) {
    return { ok: false, code: 'EMPTY', error: 'That image looks empty or unreadable. Try another file.' };
  }
  if (size > maxMb * 1024 * 1024) {
    return { ok: false, code: 'TOO_LARGE', error: `Screenshot is too large (${(size / 1048576).toFixed(1)} MB). The limit is ${maxMb} MB.` };
  }
  return { ok: true, code: 'OK', error: null };
}

/**
 * PURE. Pull the first image File out of a clipboard event's items list
 * (used by the Ctrl+V paste handler). Returns null when the clipboard has no
 * image (e.g. text was pasted).
 */
export function imageFromClipboard(items) {
  for (const item of items || []) {
    if (item && item.kind === 'file' && String(item.type || '').startsWith('image/')) {
      const file = item.getAsFile ? item.getAsFile() : null;
      if (file) return file;
    }
  }
  return null;
}

const OPERATION_LABEL = {
  edit_media_text_to_photo: 'Convert existing text message to photo',
  edit_media: 'Replace the photo',
  edit_caption: 'Update the caption',
  edit_text: 'Update the message text',
  none: 'Update the message',
};

/** PURE. Backward-compatible status: prefer the structured `status`, else infer
 *  it from the legacy `code` so older responses still render sensibly. */
export function telegramStatusOf(tg) {
  if (!tg) return 'none';
  if (tg.status) return tg.status;
  const c = tg.code;
  if (!c || c === 'NOT_SENT' || c === 'NO_SENT_MESSAGE') return 'not_sent';
  if (c === 'UPDATED') return 'updated';
  if (c === 'NO_CHANGE') return 'no_change';
  if (c === 'EDIT_IN_PROGRESS') return 'in_progress';
  if (c === 'PARTIAL') return 'partial';
  return 'failed';
}

/** PURE. The safe diagnostic rows shown under a failed/unconfirmed banner so an
 *  admin can see the exact failing stage without opening server logs. */
function telegramDetailList(tg, storedLabel) {
  return [
    { label: 'Stage', value: 'Sending the stored screenshot to Telegram' },
    { label: 'Operation', value: OPERATION_LABEL[tg.operation] || 'Update the message' },
    { label: 'Result', value: tg.description || tg.detail || tg.code || 'Unknown' },
    { label: 'Attempts', value: tg.attempts != null ? String(tg.attempts) : '—' },
    ...(tg.abortedAttempts > 0
      ? [{ label: 'Timed-out requests aborted', value: `Yes (${tg.abortedAttempts} cancelled before retrying)` }]
      : []),
    { label: 'Telegram response', value: tg.telegramErrorCode != null ? `Error ${tg.telegramErrorCode}` : 'No response received' },
    { label: 'Stored screenshot', value: storedLabel },
    { label: 'New message sent', value: 'No' },
    ...(tg.correlationId ? [{ label: 'Reference', value: tg.correlationId }] : []),
  ];
}

/**
 * PURE. Turn a screenshot-change / update API result into an Admin banner,
 * truthfully distinguishing every case the backend reports (never sent, updated,
 * partial/limitation, ambiguous/unconfirmed, and hard failures). Returns a
 * concise `text` plus, for non-success outcomes, a safe `details` list.
 *
 * @param {'replace'|'remove'|'update'} action
 * @param {object} apiResult  the JSON returned by the screenshot/update endpoint
 * @returns {{ type:'success'|'warning'|'error', text:string, details?:Array }}
 */
export function screenshotStatusBanner(action, apiResult) {
  const storedLine = action === 'remove' ? 'Screenshot removed from storage.'
    : action === 'update' ? '' : 'Screenshot stored.';
  const storedLabel = action === 'remove' ? 'Removed' : 'Yes';
  const prefix = storedLine ? `${storedLine} ` : '';
  const tg = (apiResult && apiResult.telegram) || null;

  if (!tg) {
    return { type: 'success', text: (storedLine || 'Done.').trim() };
  }
  const status = telegramStatusOf(tg);

  if (status === 'not_sent') {
    return { type: 'success', text: `${prefix}The route message has not been sent to the driver group yet, so nothing was sent or changed in Telegram.`.trim() };
  }
  if (status === 'updated' || status === 'no_change') {
    const body = tg.detail || 'The existing Telegram message was updated in place — no new message was sent.';
    return { type: 'success', text: `${prefix}${body}`.trim() };
  }
  if (status === 'in_progress') {
    return { type: 'warning', text: `${prefix}Another update for this route was still in progress — try again in a moment.`.trim() };
  }
  // partial / unconfirmed / failed / caption_too_long → warning + safe details.
  // The backend `detail` is a complete, self-contained sentence (already ends
  // with "No new message was sent." where relevant) — use it verbatim.
  const body = tg.detail
    || `Telegram was not updated (${tg.code}${tg.error ? ` — ${tg.error}` : ''}). The stored route is correct and no new message was sent.`;
  return { type: 'warning', text: `${prefix}${body}`.trim(), details: telegramDetailList(tg, storedLabel) };
}
