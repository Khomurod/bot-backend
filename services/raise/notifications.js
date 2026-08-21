/**
 * The Driver Raise Review workflow's TWO Telegram destinations.
 *
 * They are two different audiences and two INDEPENDENT admin settings
 * (Settings → Telegram Groups, `message_group_settings`). Neither is ever a
 * fallback for the other; an admin may deliberately enter the same group ID in
 * both, but the application must never substitute one for the other:
 *
 *   'dispatchReview' → the REQUEST. The weekly (or "Send now") message with the
 *                      tokenized link asking a dispatch team to mark which of
 *                      its drivers qualify for the higher rate. Missing config
 *                      is a hard error: no round is opened and nothing is sent.
 *
 *   'raiseResults'   → the RESULT. Posted after a dispatch team successfully
 *                      submits: who qualifies for the higher rate and who stays
 *                      at the lower one, with team, submitter and pay period.
 *                      This is accounting/payroll information. Missing config is
 *                      NOT fatal — the submission is already saved — and it is
 *                      NEVER redirected to the dispatch group.
 *
 * Message composition is pure and separated from the send so the text can be
 * asserted without Telegram.
 */
const { DateTime } = require('luxon');
const { bot } = require('../../bot/bot');
const { safeSend } = require('../telegramHtml');
const messageGroups = require('../../database/messageRoutingSettings');
const { serviceError } = require('./errors');

/** PURE. Escape the three characters Telegram HTML treats as markup. */
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** PURE. 0.75 → "75¢". */
function formatRate(value) {
  const cents = Math.round(Number(value) * 100);
  return `${cents}¢`;
}

/**
 * PURE. Render a pay-period bound as a plain `YYYY-MM-DD` calendar date.
 *
 * `raise_rounds.period_start` / `period_end` are SQL `DATE` columns, and
 * node-postgres hands those back as a JS `Date` at LOCAL midnight — so a raw
 * interpolation produced "Mon Jun 15 2026 00:00:00 GMT+0000 (Coordinated
 * Universal Time)" in the message. Read the LOCAL calendar fields (matching how
 * node-postgres built the Date) rather than the UTC ones, which would roll the
 * date back a day east of Greenwich. An ISO string — what the scheduler and the
 * admin "Send now" pass — is already a plain date and comes through untouched.
 */
function formatPeriodDate(value) {
  if (value instanceof Date) return DateTime.fromJSDate(value).toISODate() || '';
  const text = String(value ?? '');
  const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/);
  return isoDate ? isoDate[0] : text;
}

const SEND_OPTIONS = { parse_mode: 'HTML', disable_web_page_preview: true };

// ─── Destination 1: the review REQUEST → Dispatch Rate Review group ───

/**
 * The admin-configured Dispatch Rate Review group, or a clear configuration
 * error. Resolved BEFORE a round is minted so a misconfigured deployment never
 * leaves an orphan round with an unsent link, and never silently falls back to
 * some other group.
 */
async function resolveReviewRequestGroupId() {
  const chatId = await messageGroups.getGroupId('dispatchReview');
  if (!chatId) {
    throw serviceError('NO_DISPATCH_GROUP', messageGroups.missingGroupMessage('dispatchReview'), 409);
  }
  return chatId;
}

/** PURE. The request asking a dispatch team to complete the review. */
function buildReviewRequestText({ periodStart, periodEnd, link, rateLow, rateHigh, linkTtlHours }) {
  return `💵 <b>Driver Raise Review — ${formatRate(rateHigh)}/mile</b>\n\n`
    + `Pay period: <b>${escapeHtml(formatPeriodDate(periodStart))} → ${escapeHtml(formatPeriodDate(periodEnd))}</b>\n\n`
    + `Dispatch team: please mark which company drivers performed well and cooperated this week, `
    + `so they earn <b>${formatRate(rateHigh)}/mile</b> (instead of ${formatRate(rateLow)}/mile) for this period.\n\n`
    + `👉 <a href="${escapeHtml(link)}">Open the review form</a>\n\n`
    + `<i>The link expires in ${linkTtlHours} hours.</i>`;
}

/**
 * Post the review request to the Dispatch Rate Review group. The ONLY
 * destination for the request — the results group is not involved.
 * @returns the sent Telegram message (for `raise_rounds.employee_message_id`).
 */
async function postReviewRequest({
  chatId, periodStart, periodEnd, link, rateLow, rateHigh, linkTtlHours,
}) {
  const text = buildReviewRequestText({
    periodStart, periodEnd, link, rateLow, rateHigh, linkTtlHours,
  });
  return safeSend(() => bot.telegram.sendMessage(chatId, text, SEND_OPTIONS));
}

// ─── Destination 2: the submitted RESULT → Driver Raise Results (accounting) ───

/** PURE. The submitted decision: qualifying drivers, and those who stay put. */
function buildSubmissionResultText({ round, team, dispatcherName, picks }) {
  const list = (rows) => (rows.length
    ? rows.map((r) => `• ${escapeHtml(r.driver_name)}`).join('\n')
    : '— none —');

  return `🧾 <b>Driver Raise Review submitted</b>\n`
    + `Team: <b>${escapeHtml(team.name)}</b> (by ${escapeHtml(dispatcherName)})\n`
    + `Pay period: ${escapeHtml(formatPeriodDate(round.period_start))} → ${escapeHtml(formatPeriodDate(round.period_end))}\n\n`
    + `✅ <b>Qualify for ${formatRate(round.rate_high)}/mile</b>\n${list(picks.filter((p) => p.qualified))}\n\n`
    + `❌ <b>Stay at ${formatRate(round.rate_low)}/mile</b>\n${list(picks.filter((p) => !p.qualified))}`;
}

/**
 * Post one dispatch team's submitted decision to the Driver Raise Results
 * (accounting) group.
 *
 * Called exactly once per successful submission, AFTER the response is already
 * committed. It therefore never throws and never retries: a failure here must
 * not roll back, duplicate or re-post a dispatcher's answer. When the accounting
 * group is not configured the result is not redirected to the Dispatch Rate
 * Review group — that group asks for the review, it is not the audience for the
 * pay decision — the configuration error is logged and reported instead.
 *
 * @returns {Promise<{posted: boolean, reason: string|null}>}
 */
async function postSubmissionResult({ round, team, dispatcherName, picks, submissionId = null }) {
  // Optional chaining on purpose: this line runs OUTSIDE the try, and a "never
  // lose a submission" path must not be able to throw while describing itself.
  const saved = `Team "${team?.name}" submission${submissionId ? ` #${submissionId}` : ''} `
    + `for ${formatPeriodDate(round?.period_start)}→${formatPeriodDate(round?.period_end)} IS SAVED`;
  try {
    const chatId = await messageGroups.getGroupId('raiseResults');
    if (!chatId) {
      console.error(`[RAISE] ${messageGroups.missingGroupMessage('raiseResults')} `
        + `${saved}, but the result was NOT posted anywhere — it is deliberately not sent to `
        + `the dispatch review group as a fallback. Set the Driver Raise Results group in `
        + `admin Settings → Telegram Groups (the submission stays visible in the admin panel).`);
      return { posted: false, reason: 'RESULTS_GROUP_NOT_CONFIGURED' };
    }
    const text = buildSubmissionResultText({ round, team, dispatcherName, picks });
    await safeSend(() => bot.telegram.sendMessage(chatId, text, SEND_OPTIONS));
    return { posted: true, reason: null };
  } catch (err) {
    // Non-fatal: the submission is already saved and visible in the admin panel.
    // Deliberately NOT retried — a retry could duplicate the notification.
    console.error(`[RAISE] Failed to post the raise result to the accounting group: ${err.message}. ${saved}.`);
    return { posted: false, reason: 'RESULTS_SEND_FAILED' };
  }
}

module.exports = {
  escapeHtml,
  formatRate,
  formatPeriodDate,
  resolveReviewRequestGroupId,
  buildReviewRequestText,
  postReviewRequest,
  buildSubmissionResultText,
  postSubmissionResult,
};
