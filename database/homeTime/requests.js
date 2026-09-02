/**
 * Home-Time REQUEST lifecycle — database helpers.
 *
 * A request moves pending → awaiting-dates (clarification) → decided, and the
 * writes here are the guards that keep that state machine honest: the decide is
 * atomic on 'pending' so two approvers tapping at once cannot both win, and the
 * acknowledged stamp is written once. The reminder sweep that drives the
 * clarification statuses lives in database/homeTimeClarification.js.
 *
 * Split out of database/homeTime.js, which re-exports every symbol here.
 */
const { query } = require('../pool');
// Single source of truth for the awaiting statuses lives with the clarification
// worker that guards on them.
const { AWAITING_STATUSES } = require('../homeTimeClarification');

// A driver's plain-text answer can still land after the two reminders are spent,
// so an 'unanswered' clarification is treated as open for the reply handler.
const OPEN_CLARIFICATION_STATUSES = [...AWAITING_STATUSES, 'clarification_unanswered'];

// Anything that should block a second, competing flow for the same driver.
const OPEN_REQUEST_STATUSES = [...OPEN_CLARIFICATION_STATUSES, 'pending'];

// camelCase option → column. BIGINT id columns are stringified so node-pg keeps
// full precision. Only keys present in the payload are written (dynamic INSERT),
// so the same builder serves every insert path (telegram, manual, unplanned).
const REQUEST_COLUMN_MAP = {
  groupId: 'group_id',
  telegramGroupId: 'telegram_group_id',
  driverName: 'driver_name',
  unitNumber: 'unit_number',
  requestedByUserId: 'requested_by_user_id',
  requestedByUsername: 'requested_by_username',
  roadStartedAt: 'road_started_at',
  daysOnRoad: 'days_on_road',
  policyMet: 'policy_met',
  homeFrom: 'home_from',
  homeTo: 'home_to',
  returnToRoadDate: 'return_to_road_date',
  status: 'status',
  source: 'source',
  aiReasoning: 'ai_reasoning',
  telegramChatId: 'telegram_chat_id',
  telegramMessageId: 'telegram_message_id',
  isUnplannedArrival: 'is_unplanned_arrival',
  detectedIntent: 'detected_intent',
  aiConfidence: 'ai_confidence',
  language: 'language',
  missingFields: 'missing_fields',
  rootChatId: 'root_chat_id',
  rootMessageId: 'root_message_id',
  clarificationChatId: 'clarification_chat_id',
  clarificationMessageId: 'clarification_message_id',
  lastDriverMessageId: 'last_driver_message_id',
  reminderCount: 'reminder_count',
  lastReminderAt: 'last_reminder_at',
  nextReminderAt: 'next_reminder_at',
  acknowledgedAt: 'acknowledged_at',
  policyResult: 'policy_result',
  clarificationChannel: 'clarification_channel',
  internalAlertSentAt: 'internal_alert_sent_at',
};

// BIGINT columns that must be stored as strings to survive node-pg round-trips.
const REQUEST_BIGINT_KEYS = new Set([
  'telegramGroupId', 'telegramChatId', 'rootChatId', 'clarificationChatId',
]);

function coerceRequestValue(key, value) {
  if (value === undefined) return null;
  if (value != null && REQUEST_BIGINT_KEYS.has(key)) return String(value);
  return value;
}

async function insertHomeTimeRequest(payload = {}) {
  const cols = [];
  const placeholders = [];
  const values = [];
  let i = 1;
  const withDefaults = { status: 'pending', source: 'telegram', ...payload };
  for (const [key, column] of Object.entries(REQUEST_COLUMN_MAP)) {
    if (!Object.prototype.hasOwnProperty.call(withDefaults, key)) continue;
    cols.push(column);
    placeholders.push(`$${i}`);
    values.push(coerceRequestValue(key, withDefaults[key]));
    i += 1;
  }
  const res = await query(
    `INSERT INTO home_time_requests (${cols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    values
  );
  return res.rows[0];
}

/**
 * Generic partial update over the same column allowlist. Only keys present in the
 * patch are written, so callers can advance any subset of the conversational
 * state (e.g. record a newly-supplied home-start date and flip the status to
 * awaiting_return_to_road) in one atomic UPDATE. Returns the updated row or null.
 */
async function updateHomeTimeRequestFields(id, patch = {}) {
  const sets = [];
  const values = [id];
  let i = 2;
  for (const [key, column] of Object.entries(REQUEST_COLUMN_MAP)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    sets.push(`${column} = $${i}`);
    values.push(coerceRequestValue(key, patch[key]));
    i += 1;
  }
  if (!sets.length) return getHomeTimeRequestById(id);
  const res = await query(
    `UPDATE home_time_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function getHomeTimeRequestById(id) {
  const res = await query('SELECT * FROM home_time_requests WHERE id = $1', [id]);
  return res.rows[0] || null;
}

/** Most recent still-pending request for a group (to avoid duplicate cards). */
async function getPendingHomeTimeRequestForGroup(groupId) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1 AND status = 'pending'
     ORDER BY requested_at DESC LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

/**
 * Most recent OPEN request for a group: a posted card awaiting a decision
 * ('pending'), a partial/awaiting clarification, or one whose reminders were
 * spent ('clarification_unanswered'). The duplicate guard so a re-tag or a
 * repeated Status: Home does not spawn a second flow.
 */
async function getOpenHomeTimeRequestForGroup(groupId) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1 AND status = ANY($2)
     ORDER BY requested_at DESC LIMIT 1`,
    [groupId, OPEN_REQUEST_STATUSES]
  );
  return res.rows[0] || null;
}

/**
 * Most recent OPEN clarification flow for a group (still waiting on one or both
 * dates, including an unanswered flow a late reply can still complete). Backs the
 * plain-text follow-up handler; only one active flow should exist per driver.
 */
async function getOpenClarificationForGroup(groupId) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1 AND status = ANY($2)
     ORDER BY requested_at DESC LIMIT 1`,
    [groupId, OPEN_CLARIFICATION_STATUSES]
  );
  return res.rows[0] || null;
}

/** Back-compat: most recent request waiting on the driver's dates (any awaiting). */
async function getAwaitingDatesHomeTimeRequestForGroup(groupId) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1 AND status = ANY($2)
     ORDER BY requested_at DESC LIMIT 1`,
    [groupId, AWAITING_STATUSES]
  );
  return res.rows[0] || null;
}

/** Most recent APPROVED request for a group (to link a completed cycle / dedup). */
async function getApprovedHomeTimeRequestForGroup(groupId) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1 AND status = 'approved'
     ORDER BY decided_at DESC NULLS LAST, requested_at DESC LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

/**
 * Most recent decided (approved/denied) request for a group whose home-start date
 * is within `windowDays` of `dateIso` — used to link a completing cycle to the
 * request that authorized it so approved exceptions are classified correctly.
 */
async function findDecidedRequestNearDate(groupId, dateIso, { windowDays = 3 } = {}) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1
       AND status IN ('approved', 'denied')
       AND home_from IS NOT NULL
       AND ABS(home_from - $2::date) <= $3
     ORDER BY ABS(home_from - $2::date) ASC, decided_at DESC NULLS LAST
     LIMIT 1`,
    [groupId, dateIso, windowDays]
  );
  return res.rows[0] || null;
}

/**
 * Complete an open clarification: fill BOTH dates and flip it to 'pending' so a
 * card can be posted. Also clears the reminder schedule and records the driver's
 * latest message id (final ack replies to it). Atomic status guard (any awaiting
 * state) prevents two replies both winning.
 */
async function fulfillAwaitingHomeTimeRequest(id, {
  homeFrom, homeTo, returnToRoadDate, roadStartedAt, daysOnRoad, policyMet,
  aiReasoning, lastDriverMessageId, language, aiConfidence,
}) {
  const res = await query(
    `UPDATE home_time_requests
       SET home_from = COALESCE($2, home_from),
           home_to = $3,
           return_to_road_date = COALESCE($4, return_to_road_date),
           road_started_at = COALESCE($5, road_started_at),
           days_on_road = $6,
           policy_met = $7,
           ai_reasoning = COALESCE($8, ai_reasoning),
           last_driver_message_id = COALESCE($9, last_driver_message_id),
           language = COALESCE($10, language),
           ai_confidence = COALESCE($11, ai_confidence),
           missing_fields = NULL,
           next_reminder_at = NULL,
           status = 'pending'
     WHERE id = $1 AND status = ANY($12)
     RETURNING *`,
    [
      id, homeFrom || null, homeTo || null, returnToRoadDate || null,
      roadStartedAt || null,
      daysOnRoad == null ? null : daysOnRoad,
      policyMet == null ? null : policyMet,
      aiReasoning || null,
      lastDriverMessageId == null ? null : lastDriverMessageId,
      language || null,
      aiConfidence == null ? null : aiConfidence,
      AWAITING_STATUSES,
    ]
  );
  return res.rows[0] || null;
}

/**
 * Record the bot's own clarification-question message id (so it can be edited or
 * referenced) and the reply threading root. Non-atomic; called right after the
 * ask is sent.
 */
async function setHomeTimeClarificationMessage(id, {
  clarificationChatId, clarificationMessageId,
}) {
  const res = await query(
    `UPDATE home_time_requests
       SET clarification_chat_id = $2, clarification_message_id = $3
     WHERE id = $1 RETURNING *`,
    [
      id,
      clarificationChatId != null ? String(clarificationChatId) : null,
      clarificationMessageId == null ? null : clarificationMessageId,
    ]
  );
  return res.rows[0] || null;
}

/** Stamp acknowledged_at + policy_result once (idempotency guard on the ack). */
async function markHomeTimeAcknowledged(id, policyResult) {
  const res = await query(
    `UPDATE home_time_requests
       SET acknowledged_at = NOW(), policy_result = COALESCE($2, policy_result)
     WHERE id = $1 AND acknowledged_at IS NULL
     RETURNING *`,
    [id, policyResult || null]
  );
  return res.rows[0] || null;
}

// ─── Clarification reminders (restart-safe worker) ───
// The atomic claim helpers (due-reminder sweep, reminder claim / stand-down, and
// the internal-alert claim) live in database/homeTimeClarification.js so this
// file stays within the per-file line limit. They are re-exported below, so
// every existing importer of database/homeTime.js is unchanged.

/**
 * Retire every open clarification for a group (driver went back on the road, or an
 * admin closed it): mark them 'expired' and stop their reminders. Returns count.
 */
async function expireOpenClarificationsForGroup(groupId, { reason } = {}) {
  const res = await query(
    `UPDATE home_time_requests
       SET status = 'expired', next_reminder_at = NULL,
           ai_reasoning = COALESCE($3, ai_reasoning)
     WHERE group_id = $1 AND status = ANY($2)
     RETURNING id`,
    [groupId, OPEN_CLARIFICATION_STATUSES, reason || null]
  );
  return res.rows.length;
}

/**
 * Decide a request, but only if it is still pending (atomic guard so two
 * approvers tapping at once cannot both win).
 */
async function decideHomeTimeRequest(id, { status, username, userId, homeFrom, homeTo }) {
  const res = await query(
    `UPDATE home_time_requests
       SET status = $2,
           decided_by_username = $3,
           decided_by_user_id = $4,
           decided_at = NOW(),
           home_from = COALESCE($5, home_from),
           home_to = COALESCE($6, home_to)
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, status, username || null, userId || null, homeFrom || null, homeTo || null]
  );
  return res.rows[0] || null;
}

async function setHomeTimeRequestMessage(id, telegramChatId, telegramMessageId) {
  const res = await query(
    `UPDATE home_time_requests
       SET telegram_chat_id = $2, telegram_message_id = $3
     WHERE id = $1 RETURNING *`,
    [id, telegramChatId != null ? String(telegramChatId) : null,
      telegramMessageId == null ? null : telegramMessageId]
  );
  return res.rows[0] || null;
}

/** Find a request with the exact same home window for a group (dedup on import). */
async function findHomeTimeRequestByWindow(groupId, homeFrom, homeTo) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1 AND home_from = $2 AND home_to = $3
     LIMIT 1`,
    [groupId, homeFrom, homeTo]
  );
  return res.rows[0] || null;
}

async function listHomeTimeRequests({ limit = 200 } = {}) {
  const res = await query(
    `SELECT r.*, g.group_name, dp.driver_type
     FROM home_time_requests r
     LEFT JOIN groups g ON g.id = r.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = r.group_id
     ORDER BY r.requested_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

module.exports = {
  AWAITING_STATUSES,
  OPEN_CLARIFICATION_STATUSES,
  OPEN_REQUEST_STATUSES,
  insertHomeTimeRequest,
  updateHomeTimeRequestFields,
  getHomeTimeRequestById,
  getPendingHomeTimeRequestForGroup,
  getOpenHomeTimeRequestForGroup,
  getOpenClarificationForGroup,
  getAwaitingDatesHomeTimeRequestForGroup,
  getApprovedHomeTimeRequestForGroup,
  findDecidedRequestNearDate,
  fulfillAwaitingHomeTimeRequest,
  setHomeTimeClarificationMessage,
  markHomeTimeAcknowledged,
  expireOpenClarificationsForGroup,
  decideHomeTimeRequest,
  setHomeTimeRequestMessage,
  findHomeTimeRequestByWindow,
  listHomeTimeRequests,
};
