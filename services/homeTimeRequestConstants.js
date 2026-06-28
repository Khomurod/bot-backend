/**
 * Home-Time Request — constants and pure helpers (no DB / network), so they can
 * be unit-tested in isolation.
 *
 * When a company representative tags @tomr_robins0n and/or @SaffieBNett in a
 * driver group, the bot looks at the recent conversation to decide whether it is
 * a home-time request. If it is, the bot posts an AI-written note with
 * "Approve" / "Do Not Approve" buttons that ONLY those two people may press.
 *
 * The home-time policy: a driver should be on the road at least
 * `road_allowance_weeks` (default 4) weeks before taking `home_allowance_days`
 * (default 4) days home.
 */
const { DateTime } = require('luxon');
const { homeTimePolicyApplies } = require('./homeTimeConstants');

function csvValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

// Usernames allowed to approve/deny a home-time request (case-insensitive,
// stored without the leading @). Same people as the bonus rejection escalation.
const HOME_TIME_APPROVER_USERNAMES = csvValues(process.env.HOME_TIME_APPROVER_USERNAMES);
if (!HOME_TIME_APPROVER_USERNAMES.length) {
  HOME_TIME_APPROVER_USERNAMES.push('tomr_robins0n', 'SaffieBNett');
}

// Optional immutable ids — once configured, usernames no longer grant authority.
const HOME_TIME_APPROVER_USER_IDS = new Set(csvValues(process.env.HOME_TIME_APPROVER_USER_IDS));

// Mentions to detect a request and to tag on the card.
const HOME_TIME_APPROVER_MENTIONS = HOME_TIME_APPROVER_USERNAMES.map((u) => `@${u}`);

const DAYS_PER_WEEK = 7;

/** Lowercased approver usernames (no @). */
function approverUsernamesLower() {
  return HOME_TIME_APPROVER_USERNAMES.map((u) => u.toLowerCase());
}

function isHomeTimeApproverUsername(username) {
  const u = String(username || '').replace(/^@/, '').toLowerCase();
  if (!u) return false;
  return approverUsernamesLower().includes(u);
}

/** Authoritative check: a Telegram `from` user may approve/deny. */
function isHomeTimeApprover(user) {
  const id = user?.id == null ? '' : String(user.id);
  if (HOME_TIME_APPROVER_USER_IDS.size > 0) return HOME_TIME_APPROVER_USER_IDS.has(id);
  return isHomeTimeApproverUsername(user?.username);
}

/**
 * Pull @usernames mentioned in a Telegram message from its entities. Returns
 * lowercased usernames without the leading @. Falls back to a regex over the
 * raw text when entities are missing (e.g. forwarded/edited messages).
 */
function extractMentionUsernames(message) {
  const text = message?.text || message?.caption || '';
  const entities = message?.entities || message?.caption_entities || [];
  const found = new Set();

  for (const ent of Array.isArray(entities) ? entities : []) {
    if (ent?.type === 'mention' && typeof text === 'string') {
      const slice = text.slice(ent.offset, ent.offset + ent.length);
      const handle = slice.replace(/^@/, '').trim().toLowerCase();
      if (handle) found.add(handle);
    }
  }

  // Fallback regex (covers messages without parsed entities).
  for (const match of String(text).matchAll(/@([a-z0-9_]{3,})/gi)) {
    found.add(match[1].toLowerCase());
  }

  return [...found];
}

/**
 * Does this message tag one of the home-time approvers? Checks @username
 * mentions and `text_mention` entities (users without a username) by id.
 */
function messageMentionsApprovers(message) {
  const usernames = extractMentionUsernames(message);
  const approvers = approverUsernamesLower();
  if (usernames.some((u) => approvers.includes(u))) return true;

  const entities = message?.entities || message?.caption_entities || [];
  for (const ent of Array.isArray(entities) ? entities : []) {
    if (ent?.type === 'text_mention' && ent.user) {
      if (isHomeTimeApprover(ent.user)) return true;
    }
  }
  return false;
}

/**
 * Deterministic "this looks like home-time language" detector.
 *
 * Used two ways:
 *   1. As the AI-unavailable fallback (so a tag during an outage only creates a
 *      card when the text actually mentions going home — not the old blanket
 *      "default to true" that produced false positives like an oil-change tag).
 *   2. As a guard against a low-confidence AI "yes": if the model is unsure and
 *      there is no home-time wording anywhere in the window, we do not post.
 */
const HOME_TIME_SIGNAL_PATTERNS = [
  /\bhome[\s-]*time\b/i,
  /\bhometime\b/i,
  /\btime\s*off\b/i,
  /\bdays?\s*off\b/i,
  /\boff\s*days?\b/i,
  /\bgo(?:ing|es)?\s+home\b/i,
  /\bhead(?:ing|ed|s)?\s+home\b/i,
  /\bget(?:ting|s)?\s+home\b/i,
  /\bcome(?:s|ing)?\s+home\b/i,
  /\bsend\s+(?:me|him|her|them|the\s+driver)\s+home\b/i,
  /\b(?:needs?|wants?|asking|like)\s+(?:to\s+)?(?:go|get|come|head)\s+home\b/i,
  /\bhome\s+for\s+(?:a|some|the|\d)/i,
  /\bat\s+the\s+house\b/i,
  /\bvacation\b/i,
  /\bpto\b/i,
  /\bday(?:s)?\s+(?:at\s+)?home\b/i,
];

/** True when free text contains explicit home-time / time-off wording. */
function hasHomeTimeSignal(text) {
  const str = String(text || '');
  return HOME_TIME_SIGNAL_PATTERNS.some((re) => re.test(str));
}

/**
 * Build the AI classification prompt for a possible home-time request. Pure (no
 * network) so it can be unit-tested. The most recent / triggering message is
 * shown separately from the rolling 30-minute transcript because the trigger is
 * what carries the intent, while the transcript supplies the surrounding context.
 */
function buildHomeTimeClassificationPrompt({ transcript, triggerText, approvers } = {}) {
  const approverList = (Array.isArray(approvers) && approvers.length
    ? approvers
    : HOME_TIME_APPROVER_MENTIONS).join(', ');
  return [
    'You are a strict classifier for a US trucking company dispatch group on Telegram.',
    `A company representative just tagged a manager (${approverList}). Managers get tagged for MANY`,
    'reasons: load problems, rate / PO questions, breakdowns, maintenance (oil change, tires, repairs),',
    'paperwork, detention, escalations, complaints, or general questions.',
    '',
    'Classify the conversation as a HOME-TIME REQUEST only when the driver — or a rep on the driver\'s',
    'behalf — is asking to GO HOME, take home time, time off, days off, vacation, or PTO. Anything else',
    'is NOT a home-time request, even when a manager is tagged.',
    '',
    'Examples that ARE home-time requests:',
    '- "Driver wants to go home next week, he has been out 5 weeks @manager"',
    '- "Can he get some home time? @manager"',
    '- "He is asking for a few days off at the house @manager"',
    '',
    'Examples that are NOT home-time requests:',
    '- "I think we gonna need an oil change, this is the second time I recommend it @manager"',
    '- "Rate confirmation issue on this load @manager"',
    '- "Truck broke down, need a tow @manager"',
    '- "Where is the BOL for this load? @manager"',
    '',
    'Most recent / triggering message (this carries the intent):',
    `"""\n${String(triggerText || '(unavailable)').slice(0, 800)}\n"""`,
    '',
    'Last 30 minutes of the conversation for context (oldest first):',
    `"""\n${transcript || '(no recent messages)'}\n"""`,
    '',
    'Respond with JSON only:',
    '{"is_home_time_request": true|false, "confidence": "high"|"medium"|"low", "reason": "<short>"}',
  ].join('\n');
}

/** Whole + fractional weeks for a day count (rounded to 1 decimal). */
function weeksFromDays(days) {
  const n = Math.max(0, Number(days) || 0);
  return Math.round((n / DAYS_PER_WEEK) * 10) / 10;
}

/**
 * Has the driver met the on-the-road requirement?
 * @returns {boolean|null} null when we cannot tell (no tracked road start).
 */
function isPolicyMet(daysOnRoad, roadAllowanceWeeks = 4, driverType = 'company_driver') {
  if (!homeTimePolicyApplies(driverType)) return null;
  if (daysOnRoad == null || !Number.isFinite(Number(daysOnRoad))) return null;
  const allowanceDays = Math.max(0, Number(roadAllowanceWeeks) || 0) * DAYS_PER_WEEK;
  return Number(daysOnRoad) >= allowanceDays;
}

/**
 * Proposed home-time window: `homeAllowanceDays` days starting from `fromIso`
 * (default: now). Returns ISO dates (YYYY-MM-DD).
 */
function computeHomeWindow(fromIso, homeAllowanceDays = 4, timezone = 'America/Chicago') {
  const start = fromIso
    ? DateTime.fromISO(String(fromIso), { zone: timezone })
    : DateTime.now().setZone(timezone);
  const safeStart = start.isValid ? start : DateTime.now().setZone(timezone);
  const days = Math.max(1, Number(homeAllowanceDays) || 1);
  const end = safeStart.plus({ days: days - 1 });
  return { homeFrom: safeStart.toISODate(), homeTo: end.toISODate() };
}

module.exports = {
  HOME_TIME_APPROVER_USERNAMES,
  HOME_TIME_APPROVER_USER_IDS,
  HOME_TIME_APPROVER_MENTIONS,
  DAYS_PER_WEEK,
  isHomeTimeApproverUsername,
  isHomeTimeApprover,
  extractMentionUsernames,
  messageMentionsApprovers,
  hasHomeTimeSignal,
  buildHomeTimeClassificationPrompt,
  weeksFromDays,
  homeTimePolicyApplies,
  isPolicyMet,
  computeHomeWindow,
};
