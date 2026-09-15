/**
 * Home-time request HOUSEKEEPING: closing a request whose dates have passed.
 *
 * This module was the approve/decline workflow, shared by the Telegram buttons
 * and the admin panel. Home time is no longer permitted, only reported — three
 * managers are told when a driver asks, arrives home and goes back on the road,
 * and a completed request settles as `recorded`. Both decision entry points and
 * the workflow behind them are gone.
 *
 * NOR IS ANYTHING WAITING ON A MANAGER. A request used to end "Expired — No
 * Action" when its dates passed, a sweep counted those, and the retention watch
 * read the count as the company having failed the driver. A driver asking for
 * home time is a message, not a ticket: it is recorded, three managers are
 * told, and that is the end of it. What survives here is the one genuinely
 * mechanical step — a request whose window has gone by is CLOSED, so it stops
 * blocking the next one — and closing it says nothing about anybody.
 *
 * It is emphatically NOT evidence that the driver went home. That question is
 * answered by the Dispatcher Board and the driver's own messages, in
 * services/homeTimeService.js and services/homeTime/returnToRoadWatch.js.
 *
 * The file keeps its name because `closeOutdatedRequest` is imported from it in
 * several places and a rename buys nothing; the header is the record of what it
 * stopped being.
 */
const ht = require('../database/homeTime');
const htExpiry = require('../database/homeTimeExpiry');
const { safeSend } = require('./telegramHtml');
const { buildClosedCardText } = require('./homeTimeRequestCards');
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
 * closeOutdatedRequest stays: closing a request whose dates have passed is
 * housekeeping, not a decision, and it is still called from several places.
 */
async function closeOutdatedRequest(telegram, request) {
  if (!request) return null;
  const closed = await htExpiry.closeOutdatedHomeTimeRequest(request.id);
  if (!closed) return null;
  if (telegram && closed.telegram_chat_id && closed.telegram_message_id) {
    try {
      await telegram.editMessageText(
        closed.telegram_chat_id, closed.telegram_message_id, undefined,
        buildClosedCardText(closed), { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.warn('[HOME-TIME-REQ] Could not update the closed request card:', err.message);
    }
  }
  return closed;
}

/**
 * Sweep every still-open request and close the ones whose requested period has
 * passed (or whose partial clarification has gone stale). Each close is atomic
 * and preserves all original data.
 *
 * The count it returns is a housekeeping number for the run ledger, NOT
 * something anybody is told about. "N requests expired without an answer" was
 * the notice this used to feed, and it described the calendar rather than the
 * company.
 */
async function sweepOutdatedHomeTimeRequests(telegram, { todayIso = null, staleClarificationDays } = {}) {
  const open = await htExpiry.listOpenHomeTimeRequests();
  let closed = 0;
  for (const req of open) {
    if (!isHomeTimeRequestOutdated(req, { todayIso, staleClarificationDays })) continue;
    // eslint-disable-next-line no-await-in-loop
    const row = await closeOutdatedRequest(telegram, req);
    if (row) {
      closed += 1;
      console.log(`[HOME-TIME-REQ] Request #${req.id} closed (its requested dates have passed).`);
    }
  }
  return { scanned: open.length, closed };
}

module.exports = {
  closeOutdatedRequest,
  sweepOutdatedHomeTimeRequests,
};
