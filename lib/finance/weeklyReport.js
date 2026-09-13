'use strict';

/**
 * The words of the weekly finance report. PURE — given totals, returns text.
 *
 * IT ADDS NOTHING UP. Every number it prints comes in already counted, by SQL,
 * in `database/finance/reports.js`. A composer that did its own arithmetic
 * would be a second place a total could be wrong, and the two would disagree
 * quietly. The test asserts it prints only what it was handed.
 *
 * IT NEVER SAYS WHAT A REPEAT MEANS. `same_code` is a fact — one code posted
 * twice — and `same_amount_recipient_window` is a suspicion, because two $500
 * advances to one driver in a day is sometimes exactly right. The report keeps
 * them in separate sentences with different wording, because "one code posted
 * twice" and "paid twice" are not the same claim and Wenze is in no position to
 * make the second.
 *
 * EVERYTHING INTERPOLATED IS ESCAPED. It is sent as HTML to Telegram, and the
 * values include a person's name and a money code read off a document — text
 * from outside this application. An unescaped `<` there is a message Telegram
 * refuses to send, which would turn a stray character into a missing report.
 */

const { describePeriod } = require('./schedule');

/** Telegram refuses a message over 4096; the margin is for the safety line. */
const MAX_BODY_CHARS = 3500;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function money(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * @param {object} totals  exactly what summariseFinancePeriod returned
 * @param {{periodStart: Date, periodEnd: Date}} period
 * @returns {string} HTML, at most MAX_BODY_CHARS
 */
function composeWeeklyFinanceReport(totals, { periodStart, periodEnd }) {
  const t = totals || {};
  const lines = [];

  lines.push(`<b>Money codes — ${escapeHtml(describePeriod(periodStart, periodEnd))}</b>`);
  lines.push('');

  const codes = Number(t.codeCount) || 0;
  if (codes === 0) {
    // Said plainly. "Nothing was issued" is a real and useful answer, and
    // dressing it up as an empty table makes it look like a broken report.
    lines.push('No money codes were posted in that week.');
  } else {
    lines.push(`<b>${plural(codes, 'code', 'codes')}</b>, totalling <b>${escapeHtml(money(t.amountTotal))}</b>.`);
    if (Number(t.codesWithoutAmount) > 0) {
      // Stated, not hidden in the total: a code whose amount nobody could read
      // is missing from the sum, and a reader has to know that.
      const n = Number(t.codesWithoutAmount);
      lines.push(
        `${plural(n, 'code has', 'codes have')} no amount that could be read, `
        + `so ${n === 1 ? 'it is' : 'they are'} not in that total.`,
      );
    }
  }

  // The two duplicate signals, kept apart on purpose.
  const sameCode = Number(t.duplicateSameCode) || 0;
  const sameAmount = Number(t.duplicateSameAmountWindow) || 0;
  if (sameCode > 0 || sameAmount > 0) {
    lines.push('');
    lines.push('<b>Worth a look</b>');
    if (sameCode > 0) {
      lines.push(`• ${plural(sameCode, 'code was', 'codes were')} posted more than once.`);
    }
    if (sameAmount > 0) {
      lines.push(
        `• ${plural(sameAmount, 'code matches', 'codes match')} the same amount to the same person `
        + 'inside the repeat window. That is often legitimate — it is flagged, not judged.',
      );
    }
  }

  const unread = Number(t.messagesNeedingAttention) || 0;
  const docs = Number(t.documentsNeedingReview) || 0;
  const failedDocs = Number(t.documentsFailed) || 0;
  if (unread > 0 || docs > 0 || failedDocs > 0) {
    lines.push('');
    lines.push('<b>Needs a person</b>');
    if (unread > 0) {
      lines.push(`• ${plural(unread, 'message', 'messages')} mentioned money but could not be read.`);
    }
    if (docs > 0) {
      lines.push(`• ${plural(docs, 'document', 'documents')} could not be read with enough certainty.`);
    }
    if (failedDocs > 0) {
      lines.push(`• ${plural(failedDocs, 'document', 'documents')} could not be downloaded at all.`);
    }
  }

  lines.push('');
  lines.push(
    `<i>From ${escapeHtml(String(Number(t.messageCount) || 0))} messages captured in the finance group. `
    + 'Every figure is counted from what was posted — nothing is estimated.</i>',
  );

  return truncate(lines.join('\n'));
}

/**
 * Cut to the cap on a LINE boundary.
 *
 * Cutting mid-tag would produce HTML Telegram refuses, which turns a long
 * report into no report at all — the opposite of what a length cap is for.
 */
function truncate(body) {
  if (body.length <= MAX_BODY_CHARS) return body;
  const lines = body.split('\n');
  const kept = [];
  let total = 0;
  const suffix = '\n<i>…the rest is on the Finance page.</i>';
  for (const line of lines) {
    if (total + line.length + 1 + suffix.length > MAX_BODY_CHARS) break;
    kept.push(line);
    total += line.length + 1;
  }
  return kept.join('\n') + suffix;
}

module.exports = { composeWeeklyFinanceReport, escapeHtml, money, MAX_BODY_CHARS };
