/**
 * Home-Time decision workflow — the single authority for approving / declining a
 * home-time request, shared by BOTH decision entry points:
 *   - the Telegram approval buttons (bot/homeTimeRequestHandlers.js), and
 *   - the admin panel (POST /api/home-time/requests/:id/decision).
 *
 * Routing both through one function is what guarantees the same complete business
 * result no matter where a manager decides: an atomic pending → approved/denied
 * transition that records who decided and when, stops any remaining clarification
 * reminders (via database decideHomeTimeRequest), settles the Telegram approval
 * card in place with its buttons removed when one exists, and — for an approval —
 * sends the usual employee-group announcement.
 *
 * Extracted from homeTimeRequestService (see CLAUDE.md → Module design); the
 * request service re-exports these symbols so every existing importer is
 * unchanged and the require graph stays acyclic (this module never requires the
 * request service).
 */
const config = require('../config/config');
const ht = require('../database/homeTime');
const { safeSend } = require('./telegramHtml');
const { escapeHtml, buildDecidedCardText } = require('./homeTimeRequestCards');
const { isoDateOnly, resolveRequestReturnDate } = require('./homeTimeDateResolver');

/** Announce an approved request to the employee group. Non-fatal on failure. */
async function announceApproval(telegram, request) {
  if (!config.employeeGroupId || !telegram) return;
  const who = `${escapeHtml(request.driver_name || 'A driver')}`
    + `${request.unit_number ? ` (Unit ${escapeHtml(request.unit_number)})` : ''}`;
  const by = request.decided_by_username ? `@${escapeHtml(request.decided_by_username)}` : 'a manager';
  const text = `🏠 <b>Home Time Approved</b>\n`
    + `${who} requested home time from <b>${escapeHtml(request.home_from || '—')}</b> `
    + `to <b>${escapeHtml(request.home_to || '—')}</b>.\n`
    + `Approved by ${by}.`;
  try {
    await safeSend(() => telegram.sendMessage(config.employeeGroupId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  } catch (err) {
    console.error('[HOME-TIME-REQ] Failed to announce approval to employee group:', err.message);
  }
}

/**
 * An approval requires a complete, logically-consistent home-time window: a
 * home-start date, a resolvable return-to-road date, and the return strictly
 * after the start. A decline needs no dates (you can always decline). Pure.
 */
function canApproveWindow(request) {
  const start = isoDateOnly(request?.home_from);
  const ret = resolveRequestReturnDate(request);
  return Boolean(start && ret && ret > start);
}

/**
 * Settle the Telegram approval card in place (edit the text, drop the buttons)
 * when the request has a stored card. Best-effort — a failed edit never fails the
 * decision (the DB is already authoritative). Never throws.
 */
async function settleDecisionCard(telegram, record, decision, decidedByUsername, via) {
  if (!telegram || !record.telegram_chat_id || !record.telegram_message_id) return;
  try {
    await telegram.editMessageText(
      record.telegram_chat_id, record.telegram_message_id, undefined,
      buildDecidedCardText(record, decision, decidedByUsername, { via }),
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.warn('[HOME-TIME-REQ] Could not settle request card:', err.message);
  }
}

/**
 * Approve or decline a home-time request. Never throws; returns a typed result:
 *   { ok:true, request } on success, or
 *   { ok:false, code, request? } where code ∈
 *     invalid_decision | not_found | already_decided | invalid_dates | conflict.
 *
 * @param {object|null} telegram  bot.telegram (card edit + announcement skipped when null)
 * @param {number} requestId
 * @param {object} opts
 * @param {'approved'|'denied'|'approve'|'deny'|'decline'} opts.decision
 * @param {string|null} [opts.decidedByUsername]
 * @param {number|string|null} [opts.decidedByUserId]
 * @param {'telegram'|'admin'} [opts.via]
 */
async function applyHomeTimeDecision(telegram, requestId, {
  decision, decidedByUsername = null, decidedByUserId = null, via = 'telegram',
} = {}) {
  const d = String(decision || '').toLowerCase();
  const status = ['approve', 'approved', 'yes'].includes(d) ? 'approved'
    : (['deny', 'denied', 'decline', 'declined', 'reject', 'no'].includes(d) ? 'denied' : null);
  if (!status) return { ok: false, code: 'invalid_decision' };

  const current = await ht.getHomeTimeRequestById(requestId);
  if (!current) return { ok: false, code: 'not_found' };
  if (current.status !== 'pending') return { ok: false, code: 'already_decided', request: current };
  if (status === 'approved' && !canApproveWindow(current)) {
    return { ok: false, code: 'invalid_dates', request: current };
  }

  // Atomic pending→decided guard: two managers deciding at once, from either
  // surface, cannot both win — the loser gets a conflict.
  const record = await ht.decideHomeTimeRequest(requestId, {
    status, username: decidedByUsername, userId: decidedByUserId,
  });
  if (!record) {
    const latest = await ht.getHomeTimeRequestById(requestId).catch(() => null);
    return { ok: false, code: 'conflict', request: latest || current };
  }

  await settleDecisionCard(telegram, record, status, decidedByUsername, via);
  if (status === 'approved') await announceApproval(telegram, record);
  return { ok: true, request: record };
}

module.exports = {
  announceApproval,
  applyHomeTimeDecision,
  canApproveWindow,
};
