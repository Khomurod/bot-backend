/**
 * The three things a manager is told about home time — as plain text. PURE.
 *
 * Home time used to reach managers as ONE card with Approve / Do Not Approve
 * buttons, and everything else was silence: nobody was told when a driver
 * actually got home, and nobody was told when they went back to work. That card
 * also asked a question the company had already answered — a driver who has been
 * out five weeks is going home, and a manager pressing a button changed nothing
 * about whether the truck stopped.
 *
 * So there are now THREE separate events, and none of them is a question:
 *
 *   WANTS  — the driver (or a rep) asked for home time. An intention, not proof.
 *   HOME   — Wenze has evidence the driver actually reached home. The cycle starts.
 *   ROAD   — Wenze has evidence they went back to work. The cycle closes.
 *
 * Confusing the first with the second is the mistake this module exists to make
 * impossible: each has its own heading, its own facts and its own event key.
 *
 * No I/O, no Telegram, no database — so the exact words are unit-testable, and
 * the delivery layer (services/homeTime/managerNotices.js) owns sending them
 * exactly once.
 */
const { DateTime } = require('luxon');

/** Home time is scheduled, reported and reasoned about in company time. */
const TZ = 'America/Chicago';
const DAYS_PER_WEEK = 7;

const EVENT_TYPES = Object.freeze(['request', 'arrived_home', 'back_on_road']);

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** "2026-09-18" → "Sep 18". A bare ISO date is read as a calendar date, not an instant. */
function shortDate(value) {
  if (!value) return null;
  const raw = String(value);
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? DateTime.fromISO(raw, { zone: TZ })
    : DateTime.fromJSDate(new Date(raw)).setZone(TZ);
  return dt.isValid ? dt.toFormat('LLL d') : null;
}

function whoLine(driverName, unitNumber) {
  // Upper-case FIRST, then escape. The other order upper-cases the escape
  // sequences themselves — "&lt;" becomes "&LT;", which Telegram's HTML parser
  // does not recognise, so a driver name containing a bracket would render as
  // raw entity text or reject the whole message.
  const name = escapeHtml(String(driverName || 'Driver').toUpperCase());
  return unitNumber ? `${name} (Unit ${escapeHtml(unitNumber)})` : name;
}

function roadDurationLine(daysOnRoad) {
  const days = Number(daysOnRoad);
  if (!Number.isFinite(days) || days < 0) return null;
  const weeks = Math.round((days / DAYS_PER_WEEK) * 10) / 10;
  return `On the road: <b>${days} days</b> (~${weeks} weeks)`;
}

/**
 * The event key is what makes a notice arrive ONCE. Background checks re-run
 * every few minutes and re-derive the same event; the key is stored UNIQUE, so
 * the second enqueue is a no-op rather than a second tag of three managers.
 */
function eventKeyFor(eventType, subject) {
  const id = subject == null ? '' : String(subject);
  return `${eventType}:${id}`;
}

/** A. The driver ASKED. Not proof they are home. */
function buildRequestNotice({
  driverName, unitNumber, daysOnRoad, homeFrom, returnToRoadDate, mentions = [],
}) {
  const lines = [
    `🏠 <b>Home-Time Request — ${whoLine(driverName, unitNumber)}</b>`,
    'Driver is requesting Home Time.',
  ];
  const road = roadDurationLine(daysOnRoad);
  if (road) lines.push(road);
  const from = shortDate(homeFrom);
  const to = shortDate(returnToRoadDate);
  if (from && to) lines.push(`Requested dates: <b>${from} → ${to}</b>`);
  else if (from) lines.push(`Requested dates: <b>from ${from}</b>`);
  else if (to) lines.push(`Requested dates: <b>back on the road ${to}</b>`);
  if (mentions.length) lines.push('', mentions.join(' '));
  return lines.join('\n');
}

/** B. The driver IS home. The home-time cycle has started. */
function buildArrivedHomeNotice({
  driverName, unitNumber, homeSince, plannedReturn, daysOnRoad, mentions = [],
}) {
  const lines = [
    `🏠 <b>Driver Is Home — ${whoLine(driverName, unitNumber)}</b>`,
    'Wenze detected that the driver is now home.',
  ];
  const since = shortDate(homeSince);
  if (since) lines.push(`Home since: <b>${since}</b>`);
  const road = roadDurationLine(daysOnRoad);
  if (road) lines.push(road);
  const back = shortDate(plannedReturn);
  if (back) lines.push(`Planned return: <b>${back}</b>`);
  if (mentions.length) lines.push('', mentions.join(' '));
  return lines.join('\n');
}

/** C. The driver went back to WORK. The cycle is closed and measured. */
function buildBackOnRoadNotice({
  driverName, unitNumber, endedAt, homeDays, evidence, mentions = [],
}) {
  const lines = [
    `🚛 <b>Driver Back on the Road — ${whoLine(driverName, unitNumber)}</b>`,
    'Wenze detected that the driver has returned to work.',
  ];
  const ended = shortDate(endedAt);
  if (ended) lines.push(`Home Time ended: <b>${ended}</b>`);
  const days = Number(homeDays);
  if (Number.isFinite(days) && days >= 0) {
    lines.push(`Time at home: <b>${days} ${days === 1 ? 'day' : 'days'}</b>`);
  }
  // One short phrase, never a paragraph of reasoning: a manager reads this on a
  // phone and needs to know WHY Wenze is sure, not how it thought.
  if (evidence) lines.push(`Evidence: ${escapeHtml(String(evidence).slice(0, 160))}`);
  if (mentions.length) lines.push('', mentions.join(' '));
  return lines.join('\n');
}

const BUILDERS = {
  request: buildRequestNotice,
  arrived_home: buildArrivedHomeNotice,
  back_on_road: buildBackOnRoadNotice,
};

/** Render any of the three by type. Throws on an unknown type — a typo must not post a blank card. */
function buildNotice(eventType, payload = {}) {
  const build = BUILDERS[eventType];
  if (!build) throw new Error(`Unknown home-time event type: ${eventType}`);
  return build(payload);
}

module.exports = {
  TZ,
  EVENT_TYPES,
  escapeHtml,
  shortDate,
  eventKeyFor,
  buildNotice,
  buildRequestNotice,
  buildArrivedHomeNotice,
  buildBackOnRoadNotice,
};
