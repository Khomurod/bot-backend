/**
 * AI Insights thresholds.
 *
 * These numbers decide who appears on a manager's report — the at-risk and star
 * score cut-offs, how much history counts as a baseline before a driver is
 * called "silent", and the per-card caps that keep a report readable. Grouped
 * here so a tuning change is one obvious edit.
 *
 * Split out of services/aiInsightsService.js.
 */

const AT_RISK_SCORE_THRESHOLD = 4;

const STAR_SCORE_THRESHOLD = 3;

const SILENT_BASELINE_DAYS = 30;

const SILENT_MIN_BASELINE_MSGS = 5;

const MAX_EVIDENCE_PER_CARD = 5;

const MAX_CARDS_PER_KIND = 5;

const ACK_WINDOW_MINUTES = 30;

module.exports = {
  AT_RISK_SCORE_THRESHOLD,
  STAR_SCORE_THRESHOLD,
  SILENT_BASELINE_DAYS,
  SILENT_MIN_BASELINE_MSGS,
  MAX_EVIDENCE_PER_CARD,
  MAX_CARDS_PER_KIND,
  ACK_WINDOW_MINUTES,
};
