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

/**
 * PURE. Turn a screenshot-change API result into an Admin banner, truthfully
 * distinguishing every case the backend reports:
 *   - route never sent            → stored/removed only, nothing sent
 *   - existing message updated    → success (says what changed)
 *   - partial / limitation        → warning (what Telegram could not do)
 *   - Telegram edit failed         → warning (never a false success)
 *
 * @param {'replace'|'remove'} action
 * @param {object} apiResult  the JSON returned by the screenshot endpoint
 * @returns {{ type:'success'|'warning'|'error', text:string }}
 */
export function screenshotStatusBanner(action, apiResult) {
  const storedLine = action === 'remove' ? 'Screenshot removed from storage.' : 'Screenshot stored.';
  const tg = apiResult && apiResult.telegram;

  if (!tg || tg.code === 'NOT_SENT' || tg.code === 'NO_SENT_MESSAGE') {
    return {
      type: 'success',
      text: `${storedLine} The route message has not been sent to the driver group yet, so nothing was sent or changed in Telegram.`,
    };
  }
  if (tg.code === 'UPDATED') {
    return { type: 'success', text: `${storedLine} ${tg.detail || 'The existing Telegram message was updated in place — no new message was sent.'}` };
  }
  if (tg.code === 'EDIT_IN_PROGRESS') {
    return { type: 'warning', text: `${storedLine} Another update for this route was still in progress — try again in a moment.` };
  }
  // Every other outcome (PARTIAL, CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION, and
  // hard failures like BOT_PERMISSION / MESSAGE_NOT_FOUND / TELEGRAM_EDIT_* /
  // UPDATE_ERROR) is a warning. The backend `detail` is already a complete,
  // self-contained sentence — use it verbatim so we never double the
  // "No new message was sent." clause. Fall back to a safe generic when absent.
  const detail = tg.detail
    || `Telegram was not updated (${tg.code}${tg.error ? ` — ${tg.error}` : ''}). The stored route is correct and no new message was sent.`;
  return { type: 'warning', text: `${storedLine} ${detail}` };
}
