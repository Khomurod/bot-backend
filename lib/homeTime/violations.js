'use strict';

/**
 * Home-time policy violations, as Bitrix24 reports them. PURE.
 *
 * Wenze's policy: 28 days on the road, then up to 4 days home. Accounting
 * charges a company driver who goes home early or stays home too long. The
 * VERDICT is not the app's: an external script moves each company driver's card
 * in Bitrix pipeline 33 ("6. HOMETIME MONITORING"), and three of its stages are
 * violations. This module reads a card, says which violations it shows, and
 * words the message — it never computes a violation from the app's own
 * home-time state (services/homeTimeService.js), which answers a different
 * question and is not touched.
 *
 * See docs/architecture/home-time-violation-alerts.md.
 */

const crypto = require('node:crypto');
const { DateTime } = require('luxon');

const CATEGORY_ID = 33;

/** The violation stages, and what each one says. Every other stage is silence. */
const STAGE_VIOLATIONS = Object.freeze({
  'C33:UC_HTEARLY': Object.freeze(['early']),
  'C33:UC_HTREDFLAG': Object.freeze(['overstay']),
  'C33:UC_HTEARLYOVER': Object.freeze(['early', 'overstay']),
});
const VIOLATION_STAGE_IDS = Object.freeze(Object.keys(STAGE_VIOLATIONS));

/** The card's fields this reads, by the codes the script writes. */
const FIELDS = Object.freeze({
  homeFrom: 'UF_CRM_HT_FROM',
  homeUntil: 'UF_CRM_HT_UNTIL',
  homeDays: 'UF_CRM_HT_LAST_DAYS',
  roadDays: 'UF_CRM_HT_ROAD_BEFORE',
  allowDays: 'UF_CRM_HT_ALLOW',
});
const DEAL_SELECT = Object.freeze(['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', ...Object.values(FIELDS)]);

/** The written policy, for the message. The stage — not these numbers — decides. */
const POLICY = Object.freeze({ roadDays: 28, homeDays: 4 });

const TZ = 'America/Chicago';

/** Accounting's two buttons. `htv` = home-time violation. */
const CALLBACK_PATTERN = /^htv:(c|n):(\d+)$/;

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A Bitrix date ("2026-10-03" or "2026-10-03T03:00:00+03:00") as the calendar date it names. */
function bitrixDate(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || '').trim());
  return m ? m[1] : null;
}

function wholeNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * One Bitrix card → what it shows, or why it shows nothing.
 *
 * NO HOME-SINCE DATE, NO ALERT. The date is half of the idempotency key — one
 * alert per violation per home stay — and a guessed one would either repeat an
 * alert or swallow the next stay's. The caller logs and skips.
 */
function readViolationDeal(row) {
  const dealId = wholeNumber(row?.ID);
  if (!dealId || dealId <= 0) return { ok: false, reason: 'no_deal_id' };
  const stageId = String(row.STAGE_ID || '');
  if (String(row.CATEGORY_ID) !== String(CATEGORY_ID) || !STAGE_VIOLATIONS[stageId]) {
    return { ok: false, reason: 'not_a_violation_stage', dealId, stageId };
  }
  const homeFrom = bitrixDate(row[FIELDS.homeFrom]);
  if (!homeFrom) return { ok: false, reason: 'no_home_from', dealId, stageId };
  return {
    ok: true,
    dealId,
    stageId,
    driverName: String(row.TITLE || '').trim() || null,
    homeFrom,
    roadDays: wholeNumber(row[FIELDS.roadDays]),
    homeDays: wholeNumber(row[FIELDS.homeDays]),
    allowDays: wholeNumber(row[FIELDS.allowDays]),
    violations: [...STAGE_VIOLATIONS[stageId]],
  };
}

/**
 * Which of a stage's violations still need a message for this home stay.
 * EARLY → later EARLY & OVERSTAYED: only the overstay is new.
 */
function violationsToPost(stageViolations, alreadyRecorded) {
  const done = new Set(alreadyRecorded || []);
  return (stageViolations || []).filter((v) => !done.has(v));
}

/** The key the table holds UNIQUE: one alert per violation per home stay. */
function violationKey({ dealId, homeFrom, violation }) {
  return `${Number(dealId)}:${homeFrom}:${violation}`;
}

/** Expected field codes `crm.deal.fields` does not know. Empty = all present. */
function missingFieldCodes(dealFields) {
  const known = dealFields && typeof dealFields === 'object' ? dealFields : {};
  return Object.values(FIELDS).filter((code) => !Object.prototype.hasOwnProperty.call(known, code));
}

/** Violation stages `crm.status.list` (DEAL_STAGE_33) does not have. */
function missingStageIds(stageRows) {
  const present = new Set((stageRows || []).map((r) => String(r.STATUS_ID || '')));
  return VIOLATION_STAGE_IDS.filter((id) => !present.has(id));
}

function shortDate(isoDate) {
  const dt = DateTime.fromISO(String(isoDate || ''), { zone: TZ });
  return dt.isValid ? dt.toFormat('LLL d') : null;
}

function violationLine(violation, { roadDays, homeDays }) {
  if (violation === 'early') {
    const facts = roadDays == null ? '' : ` — ${roadDays} days on the road (policy: ${POLICY.roadDays})`;
    return `<b>Came home early</b>${facts}`;
  }
  const facts = homeDays == null ? '' : ` — ${homeDays} days at home (policy: ${POLICY.homeDays})`;
  return `<b>Overstayed</b>${facts}`;
}

/** The alert. No dollar amount: what to charge is a person's decision. */
function buildViolationMessage({
  driverName, violations, roadDays = null, homeDays = null, homeFrom, mentions = [],
}) {
  const list = (violations || []).filter((v) => v === 'early' || v === 'overstay');
  if (!list.length) throw new Error('buildViolationMessage: no violation to report');
  const lines = [
    '🚨 <b>Home-time policy violation — driver must be charged</b>',
    `Driver: <b>${escapeHtml(String(driverName || 'Unknown driver').toUpperCase())}</b>`,
  ];
  if (list.length === 1) {
    lines.push(`Violation: ${violationLine(list[0], { roadDays, homeDays })}`);
  } else {
    lines.push('Violations:');
    for (const v of list) lines.push(`• ${violationLine(v, { roadDays, homeDays })}`);
  }
  const since = shortDate(homeFrom);
  if (since) lines.push(`Home since: <b>${since}</b>`);
  const who = (mentions || []).filter(Boolean).map(escapeHtml).join(' ');
  lines.push('', `${who ? `${who} ` : ''}please charge this driver for violating Wenze's home-time policy.`);
  return lines.join('\n');
}

function keyboardFor(noticeId) {
  return {
    inline_keyboard: [[
      { text: '✅ Charged', callback_data: `htv:c:${Number(noticeId)}` },
      { text: '❌ Not charging', callback_data: `htv:n:${Number(noticeId)}` },
    ]],
  };
}

/** "@username" when the presser has one, their name otherwise — as the handler recorded it. */
function personLabel(name) {
  const clean = String(name || '').trim();
  return clean ? escapeHtml(clean) : 'accounting';
}

/** What the message says once accounting has answered. Appended to the original text. */
function decisionFooter({
  decision, decidedByName, decidedAt, reason = null,
}) {
  const when = shortDate(DateTime.fromJSDate(new Date(decidedAt || Date.now())).setZone(TZ).toISODate());
  const by = personLabel(decidedByName);
  if (decision === 'charged') return `\n\n✅ <b>Charged</b> by ${by} on ${when}`;
  const why = reason
    ? `Reason: ${escapeHtml(String(reason).slice(0, 500))}`
    : `Reason: waiting for ${by} to reply`;
  return `\n\n❌ <b>Not charging</b> — decided by ${by} on ${when}\n${why}`;
}

function reasonPrompt(decidedByName) {
  return `${personLabel(decidedByName)}, why is this driver not being charged? `
    + 'Reply to this message with a short reason.';
}

/** The webhook's secret, compared in constant time. An unset secret matches nothing. */
function tokensMatch(given, expected) {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * The deal a Bitrix robot is talking about. Its "Webhook" robot sends
 * `document_id[2]=DEAL_123` (form-encoded, read flat by express.urlencoded with
 * extended:false); a robot configured by hand can also pass `deal_id`.
 */
function dealIdFromWebhook(body = {}, query = {}) {
  const candidates = [
    query.deal_id, body.deal_id,
    body['document_id[2]'],
    Array.isArray(body.document_id) ? body.document_id[2] : body.document_id,
  ];
  for (const raw of candidates) {
    const m = /^(?:DEAL_)?(\d{1,12})$/.exec(String(raw ?? '').trim());
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return null;
}

module.exports = {
  CATEGORY_ID,
  STAGE_VIOLATIONS,
  VIOLATION_STAGE_IDS,
  FIELDS,
  DEAL_SELECT,
  POLICY,
  CALLBACK_PATTERN,
  readViolationDeal,
  violationsToPost,
  violationKey,
  missingFieldCodes,
  missingStageIds,
  buildViolationMessage,
  keyboardFor,
  decisionFooter,
  reasonPrompt,
  tokensMatch,
  dealIdFromWebhook,
};
