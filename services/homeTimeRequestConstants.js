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
const { hasHomeTimeSignal } = require('./homeTimeSignals');

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

// The home-time / time-off wording detector (`hasHomeTimeSignal`) now lives in
// ./homeTimeSignals so its broad and STRICT variants share one pattern set. It
// is imported above and re-exported below to keep this module's public surface
// (and every existing importer) unchanged.

/**
 * Build the AI classification prompt for a possible home-time request. Pure (no
 * network) so it can be unit-tested. The most recent / triggering message is
 * shown separately from the rolling 30-minute transcript because the trigger is
 * what carries the intent, while the transcript supplies the surrounding context.
 *
 * The model is also asked to extract the requested home-time WINDOW (start/end
 * dates) when the driver stated it ("from July 2 to July 8", "home for 4 days
 * starting Monday"). `todayLabel` anchors relative dates.
 */
function buildHomeTimeClassificationPrompt({
  transcript, triggerText, approvers, todayLabel,
} = {}) {
  const approverList = (Array.isArray(approvers) && approvers.length
    ? approvers
    : HOME_TIME_APPROVER_MENTIONS).join(', ');
  const today = todayLabel || DateTime.now().setZone('America/Chicago').toISODate();
  return [
    'You are a strict classifier for a US trucking company dispatch group on Telegram.',
    `Today is ${today} (America/Chicago). Use it to resolve relative dates like "next Monday" or "the 4th".`,
    `A company representative just tagged a manager (${approverList}). Managers get tagged for MANY`,
    'reasons: load problems, rate / PO questions, breakdowns, maintenance (oil change, tires, repairs),',
    'paperwork, detention, escalations, complaints, or general questions.',
    '',
    'Classify the conversation as a HOME-TIME REQUEST only when the driver — or a rep on the driver\'s',
    'behalf — is asking to GO HOME, take home time, time off, days off, vacation, or PTO. Anything else',
    'is NOT a home-time request, even when a manager is tagged. Judge the MEANING and INTENTION of the',
    'message, not the mere presence of the words "home" or "house". A brief stop or errand near home is',
    'NOT time off: passing by the house, picking up or dropping off belongings/clothes/documents/medicine/',
    'equipment, dropping someone off, passing through the hometown, sleeping home one night because the',
    'route passes nearby, or a pickup/delivery/repair/appointment located near the home.',
    '',
    'When it IS a home-time request, also extract the requested window:',
    '- If the driver gives a start AND end date, return both as YYYY-MM-DD.',
    '- If they give a start date plus a duration ("4 days from July 2"), compute the end date.',
    '- If no specific dates are stated (e.g. "he wants to go home soon"), set dates_specified=false',
    '  and home_from/home_to to null. Do NOT guess or default to today.',
    '',
    'Examples that ARE home-time requests:',
    '- "Driver wants to go home next week, he has been out 5 weeks @manager"',
    '- "Can he get home time from July 2 to July 8? @manager"',
    '- "He is asking for a few days off at the house @manager"',
    '',
    'Examples that are NOT home-time requests:',
    '- "I think we gonna need an oil change, this is the second time I recommend it @manager"',
    '- "Rate confirmation issue on this load @manager"',
    '- "Truck broke down, need a tow @manager"',
    '- "Where is the BOL for this load? @manager"',
    '- "Please talk to the driver. He needs to pass by his house to pick up his personal belongings @manager"',
    '- "He is dropping his trailer and swinging by home for the night, back out tomorrow @manager"',
    '- "Route takes him through his hometown, he wants to grab some clothes @manager"',
    '',
    'Most recent / triggering message (this carries the intent):',
    `"""\n${String(triggerText || '(unavailable)').slice(0, 800)}\n"""`,
    '',
    'Last 30 minutes of the conversation for context (oldest first):',
    `"""\n${transcript || '(no recent messages)'}\n"""`,
    '',
    'Respond with JSON only:',
    '{"is_home_time_request": true|false, "confidence": "high"|"medium"|"low",'
      + ' "dates_specified": true|false, "home_from": "YYYY-MM-DD"|null,'
      + ' "home_to": "YYYY-MM-DD"|null, "reason": "<short>"}',
  ].join('\n');
}

/**
 * Prompt for parsing a driver's follow-up reply once the bot has asked which
 * dates they want. Pure. `todayLabel` anchors relative dates.
 */
function buildHomeTimeDateReplyPrompt({ text, todayLabel } = {}) {
  const today = todayLabel || DateTime.now().setZone('America/Chicago').toISODate();
  return [
    'A truck driver was asked which dates they want for home time. Read their reply and extract the',
    `home-time window. Today is ${today} (America/Chicago); resolve relative dates against it.`,
    '- If you find a start and end date, return both as YYYY-MM-DD.',
    '- If only a start date plus a duration is given, compute the end date.',
    '- If only a single date is given, use it for both start and end.',
    '- If you cannot find any date, set found=false and the dates to null.',
    '',
    'Reply:',
    `"""\n${String(text || '').slice(0, 600)}\n"""`,
    '',
    'Respond with JSON only:',
    '{"found": true|false, "home_from": "YYYY-MM-DD"|null, "home_to": "YYYY-MM-DD"|null}',
  ].join('\n');
}

/** Friendly group message asking the driver for BOTH home-time dates. */
function buildAskForDatesMessage() {
  return 'Got it — I can put in a home-time request. What dates would you like to be home? '
    + 'Please reply with the day you want to arrive home and the day you plan to be back on the road '
    + '(for example: home Jul 2, back on the road Jul 6).';
}

/**
 * Deterministic fallback for the conversational clarification asks. `kind` picks
 * which single piece is still missing. Friendly + firm; the AI produces a
 * language-matched version and these are the safety net.
 */
function buildClarificationMessage(kind) {
  switch (kind) {
    case 'return_to_road':
      return 'Brother, what date are you planning to get back on the road after your home time?';
    case 'home_start':
      return 'Brother, what date are you planning to arrive home?';
    case 'unplanned_return':
      return 'Brother, welcome home! When are you planning to get back on the road after your home time?';
    default:
      return buildAskForDatesMessage();
  }
}

/**
 * Deterministic fallback for a clarification REMINDER. Names the specific missing
 * date so the driver knows exactly what to answer.
 */
function buildReminderMessage(missingField) {
  if (missingField === 'return_to_road') {
    return 'Brother, please clarify the date when you will be back on the road after home time. '
      + 'It is important for us to know.';
  }
  if (missingField === 'home_start') {
    return 'Brother, please let us know the date you are planning to arrive home. '
      + 'It is important for us to know.';
  }
  return 'Brother, please let us know your home-time dates (arrive home and back on the road). '
    + 'It is important for us to know.';
}

/** Deterministic fallback: compliant acknowledgment (paired with a 👍 reaction). */
function buildPolicyAckMessage() {
  return 'Awesome, I took note. Thanks for letting me know.';
}

/** Deterministic fallback: firm-but-friendly policy reminder (over home / short road). */
function buildPolicyWarningMessage(allowanceWeeks = 4, homeAllowanceDays = 4) {
  return `Brother, please follow our initial agreement of ${allowanceWeeks} weeks on the road and up to `
    + `${homeAllowanceDays} days at home, if you don't mind.`;
}

/**
 * Evaluate the home-time policy for a driver once complete dates are known.
 * Company-driver only; owner operators are not applicable. An approved exception
 * is surfaced separately so it never draws an ordinary violation warning.
 *
 * @returns {{ applies:boolean, result:string, compliant:boolean }}
 *   result ∈ not_applicable | approved_exception | compliant | over_home |
 *            short_road | unknown
 */
function evaluatePolicy({
  daysOnRoad = null, homeDays = null, roadAllowanceWeeks = 4, homeAllowanceDays = 4,
  driverType = 'company_driver', hasApprovedException = false,
} = {}) {
  if (!homeTimePolicyApplies(driverType)) {
    return { applies: false, result: 'not_applicable', compliant: false };
  }
  if (hasApprovedException) {
    return { applies: true, result: 'approved_exception', compliant: true };
  }
  const allowanceDays = Math.max(0, Number(roadAllowanceWeeks) || 0) * DAYS_PER_WEEK;
  const road = daysOnRoad == null ? null : Number(daysOnRoad);
  const home = homeDays == null ? null : Number(homeDays);
  // Over the home-day allowance takes precedence in the message.
  if (home != null && home > Math.max(0, Number(homeAllowanceDays) || 0)) {
    return { applies: true, result: 'over_home', compliant: false };
  }
  if (road != null && road < allowanceDays) {
    return { applies: true, result: 'short_road', compliant: false };
  }
  if (road == null && home == null) {
    return { applies: true, result: 'unknown', compliant: false };
  }
  return { applies: true, result: 'compliant', compliant: true };
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Quick gate: does this text plausibly contain a date? Used to avoid an AI call
 * (and a DB lookup) on ordinary chatter while waiting for a date reply.
 */
function looksLikeDateReply(text) {
  const str = String(text || '');
  if (/\b\d{1,2}\s*[/-]\s*\d{1,2}\b/.test(str)) return true; // 7/2, 07-02
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(str)) return true; // ISO
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(str)) return true;
  if (/\b\d{1,2}(?:st|nd|rd|th)\b/i.test(str)) return true; // 2nd, 8th
  if (/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(str)) return true;
  return false;
}

/** Resolve a bare month/day (no year) to the nearest upcoming year. */
function resolveYearForMonthDay(month, day, ref) {
  let dt = DateTime.fromObject({ year: ref.year, month, day }, { zone: ref.zone });
  if (!dt.isValid) return null;
  // If the date already passed by more than a couple days, assume next year.
  if (dt < ref.minus({ days: 2 })) {
    dt = dt.plus({ years: 1 });
  }
  return dt;
}

/**
 * Best-effort deterministic parser for an explicit date range in free text.
 * Used as the fallback when the AI is unavailable. Returns ISO date strings
 * `{ homeFrom, homeTo }` (oldest first) or null when no date is found.
 */
function parseHomeTimeWindowText(text, referenceIso, timezone = 'America/Chicago') {
  const str = String(text || '');
  if (!str.trim()) return null;
  const ref = referenceIso
    ? DateTime.fromISO(String(referenceIso), { zone: timezone })
    : DateTime.now().setZone(timezone);
  const refSafe = ref.isValid ? ref : DateTime.now().setZone(timezone);

  const found = []; // { index, end, dt }
  const accept = (index, end, dt) => {
    if (!dt || !dt.isValid) return;
    if (found.some((f) => index < f.end && end > f.index)) return; // overlaps an accepted span
    found.push({ index, end, dt });
  };

  const monthAlt = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

  // ISO yyyy-mm-dd
  for (const m of str.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const dt = DateTime.fromObject(
      { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
      { zone: timezone }
    );
    accept(m.index, m.index + m[0].length, dt);
  }
  // Month name + day (+ optional year): "July 2", "jul 2nd, 2026"
  for (const m of str.matchAll(new RegExp(`\\b(${monthAlt})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, 'gi'))) {
    const month = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
    const day = Number(m[2]);
    const dt = m[3]
      ? DateTime.fromObject({ year: Number(m[3]), month, day }, { zone: timezone })
      : resolveYearForMonthDay(month, day, refSafe);
    accept(m.index, m.index + m[0].length, dt);
  }
  // Day + month (+ optional year): "2nd of July", "8 July 2026"
  for (const m of str.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlt})[a-z]*\\.?(?:,?\\s*(\\d{4}))?`, 'gi'))) {
    const month = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    const day = Number(m[1]);
    const dt = m[3]
      ? DateTime.fromObject({ year: Number(m[3]), month, day }, { zone: timezone })
      : resolveYearForMonthDay(month, day, refSafe);
    accept(m.index, m.index + m[0].length, dt);
  }
  // Numeric m/d (+ optional year): "7/2", "07/02/2026"
  for (const m of str.matchAll(/\b(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?\b/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    let year = m[3] ? Number(m[3]) : null;
    if (year != null && year < 100) year += 2000;
    const dt = year != null
      ? DateTime.fromObject({ year, month, day }, { zone: timezone })
      : resolveYearForMonthDay(month, day, refSafe);
    accept(m.index, m.index + m[0].length, dt);
  }

  if (!found.length) return null;
  found.sort((a, b) => a.index - b.index);
  let from = found[0].dt;
  let to = found.length > 1 ? found[1].dt : found[0].dt;
  if (to < from) [from, to] = [to, from];
  return { homeFrom: from.toISODate(), homeTo: to.toISODate() };
}

/**
 * Is `{homeFrom, homeTo}` a sane home-time window? Both must be valid YYYY-MM-DD,
 * end on/after start, and start within [yesterday, +1 year] of the reference.
 */
function isReasonableHomeWindow(homeFrom, homeTo, referenceIso, timezone = 'America/Chicago') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(homeFrom || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(homeTo || ''))) {
    return false;
  }
  const from = DateTime.fromISO(String(homeFrom), { zone: timezone });
  const to = DateTime.fromISO(String(homeTo), { zone: timezone });
  if (!from.isValid || !to.isValid) return false;
  if (to < from) return false;
  const ref = referenceIso
    ? DateTime.fromISO(String(referenceIso), { zone: timezone })
    : DateTime.now().setZone(timezone);
  const refSafe = ref.isValid ? ref : DateTime.now().setZone(timezone);
  if (from < refSafe.minus({ days: 1 }).startOf('day')) return false;
  if (from > refSafe.plus({ years: 1 })) return false;
  return true;
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
  buildHomeTimeDateReplyPrompt,
  buildAskForDatesMessage,
  buildClarificationMessage,
  buildReminderMessage,
  buildPolicyAckMessage,
  buildPolicyWarningMessage,
  evaluatePolicy,
  looksLikeDateReply,
  parseHomeTimeWindowText,
  isReasonableHomeWindow,
  weeksFromDays,
  homeTimePolicyApplies,
  isPolicyMet,
  computeHomeWindow,
};
