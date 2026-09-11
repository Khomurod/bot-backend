/**
 * Home-time request HOUSEKEEPING: closing a request whose dates have passed.
 *
 * This module was the approve/decline workflow, shared by the Telegram buttons
 * and the admin panel. Home time is no longer permitted, only reported — three
 * managers are told when a driver asks, arrives home and goes back on the road,
 * and a completed request settles as `recorded`. Both decision entry points and
 * the workflow behind them are gone.
 *
 * What is left is not a decision. A request whose requested window has already
 * passed with nothing having happened is closed as expired, its card settled in
 * place. That was housekeeping before the change and it is housekeeping now, so
 * it stays, called from the request service's sweep and from the manager-tag
 * path.
 *
 * The file keeps its name because `expireOutdatedRequest` is imported from it in
 * two places and a rename buys nothing; the header is the record of what it
 * stopped being.
 */
const ht = require('../database/homeTime');
const htExpiry = require('../database/homeTimeExpiry');
const { safeSend } = require('./telegramHtml');
const { buildExpiredCardText } = require('./homeTimeRequestCards');
const {
  isoDateOnly, resolveRequestReturnDate, isHomeTimeWindowInPast, isHomeTimeRequestOutdated,
} = require('./homeTimeDateResolver');

/*
 * applyHomeTimeDecision and announceApproval lived here.
 *
 * They were the approve/decline workflow, shared by the Telegram buttons and
 * the admin panel. Home time is no longer permitted, only reported, so both
 * callers are gone and the workflow with them — a retired path kept "just in
 * case" is a path that comes back.
 *
 * expireOutdatedRequest stays: closing a request whose dates have passed is
 * housekeeping, not a decision, and it is still called from two places.
 */
async function expireOutdatedRequest(telegram, request) {
  if (!request) return null;
  const expired = await htExpiry.expireOutdatedHomeTimeRequest(request.id);
  if (!expired) return null;
  if (telegram && expired.telegram_chat_id && expired.telegram_message_id) {
    try {
      await telegram.editMessageText(
        expired.telegram_chat_id, expired.telegram_message_id, undefined,
        buildExpiredCardText(expired), { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.warn('[HOME-TIME-REQ] Could not update expired card:', err.message);
    }
  }
  return expired;
}

/**
 * Sweep every still-open request and auto-close the ones whose requested period
 * has passed (or whose partial clarification has gone stale). Each close is
 * atomic and preserves all original data. Returns a small summary.
 */
async function sweepOutdatedHomeTimeRequests(telegram, { todayIso = null, staleClarificationDays } = {}) {
  const open = await htExpiry.listOpenHomeTimeRequests();
  let expired = 0;
  for (const req of open) {
    if (!isHomeTimeRequestOutdated(req, { todayIso, staleClarificationDays })) continue;
    // eslint-disable-next-line no-await-in-loop
    const row = await expireOutdatedRequest(telegram, req);
    if (row) {
      expired += 1;
      console.log(`[HOME-TIME-REQ] Request #${req.id} auto-closed (Expired — No Action; requested dates passed).`);
    }
  }
  return { scanned: open.length, expired };
}

module.exports = {
  expireOutdatedRequest,
  sweepOutdatedHomeTimeRequests,
};
