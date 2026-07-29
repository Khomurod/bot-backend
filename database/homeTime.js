/**
 * Driver Home-Time Tracking — database helpers.
 *
 * Backs the home/road tracker: a single settings row, the current state of each
 * driver group, and a history of completed road trips with their bonus.
 */
const { query } = require('./db');
// Atomic clarification/reminder claim helpers, split out for the file-size
// limit and re-exported below so importers of this module are unchanged.
const clarification = require('./homeTimeClarification');

// ─── Settings (single row, id = 1) ───

async function getHomeTimeSettings() {
  const res = await query('SELECT * FROM home_time_settings WHERE id = 1');
  return res.rows[0] || null;
}

const SETTINGS_COLUMNS = [
  'enabled', 'road_allowance_weeks', 'home_allowance_days', 'bonus_per_week',
  'reminder_first_hours', 'reminder_second_hours', 'completed_notify_group_id',
  // Silent mode: whether the bot may message DRIVER groups at all, and where the
  // internal "staff must clarify these dates" alert goes when it may not.
  'driver_clarification_enabled', 'internal_clarification_group_id',
];

async function updateHomeTimeSettings(patch = {}) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const col of SETTINGS_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, col)) {
      sets.push(`${col} = $${i}`);
      values.push(patch[col]);
      i += 1;
    }
  }
  if (!sets.length) return getHomeTimeSettings();
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE home_time_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

// ─── Per-group current state ───

async function getDriverHomeStatus(groupId) {
  const res = await query('SELECT * FROM driver_home_status WHERE group_id = $1', [groupId]);
  return res.rows[0] || null;
}

/**
 * Insert or update the current state for a driver group.
 *
 * `roadBonusWeeksNotified` resets the extra-week notification watermark. Every
 * real state transition (home→road, road→home, first observation) starts a
 * fresh leg, so callers pass 0 there; the periodic notifier advances it later
 * via setRoadBonusWeeksNotified() without disturbing the state.
 */
async function upsertDriverHomeStatus({
  groupId, telegramGroupId, state, stateSince, lastStatusText, lastStatusAt,
  roadBonusWeeksNotified = 0,
}) {
  const res = await query(
    `INSERT INTO driver_home_status
       (group_id, telegram_group_id, state, state_since, last_status_text, last_status_at, road_bonus_weeks_notified, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (group_id) DO UPDATE SET
       telegram_group_id = EXCLUDED.telegram_group_id,
       state = EXCLUDED.state,
       state_since = EXCLUDED.state_since,
       last_status_text = EXCLUDED.last_status_text,
       last_status_at = EXCLUDED.last_status_at,
       road_bonus_weeks_notified = EXCLUDED.road_bonus_weeks_notified,
       updated_at = NOW()
     RETURNING *`,
    [groupId, telegramGroupId != null ? String(telegramGroupId) : null, state, stateSince,
      lastStatusText || null, lastStatusAt, Math.max(0, Number(roadBonusWeeksNotified) || 0)]
  );
  return res.rows[0];
}

/**
 * Advance (or reset) the extra-week notification watermark for a group without
 * touching its state. Called by the periodic road-bonus notifier after it posts
 * newly-completed weeks, so the same milestone is never posted twice.
 */
async function setRoadBonusWeeksNotified(groupId, weeksNotified) {
  const res = await query(
    `UPDATE driver_home_status
       SET road_bonus_weeks_notified = $2, updated_at = NOW()
     WHERE group_id = $1 RETURNING *`,
    [groupId, Math.max(0, Number(weeksNotified) || 0)]
  );
  return res.rows[0] || null;
}

/**
 * Every driver group currently ON THE ROAD, with the labels + driver type
 * needed to compute and post extra-week bonus milestones. Used by the periodic
 * notifier; owner-operator filtering happens in the service (driver_type can be
 * null here and is then inferred from the group name).
 */
async function listOnRoadStatuses() {
  const res = await query(
    `SELECT s.group_id, s.telegram_group_id, s.state, s.state_since,
            s.road_bonus_weeks_notified,
            g.group_name, g.active AS group_active,
            dp.first_name, dp.last_name, dp.unit_number, dp.driver_type
     FROM driver_home_status s
     JOIN groups g ON g.id = s.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = s.group_id
     WHERE s.state = 'road'
     ORDER BY s.state_since ASC`
  );
  return res.rows;
}

/** Touch only the "last seen status" fields without changing the state. */
async function touchDriverHomeStatus({ groupId, lastStatusText, lastStatusAt }) {
  const res = await query(
    `UPDATE driver_home_status
     SET last_status_text = $2, last_status_at = $3, updated_at = NOW()
     WHERE group_id = $1 RETURNING *`,
    [groupId, lastStatusText || null, lastStatusAt]
  );
  return res.rows[0] || null;
}

// ─── Completed road trips (history) ───

async function insertRoadHistory({
  groupId, driverName, unitNumber, roadStartedAt, homeArrivedAt,
  daysOnRoad, exceededWeeks, bonusUsd,
}) {
  const res = await query(
    `INSERT INTO driver_road_history
       (group_id, driver_name, unit_number, road_started_at, home_arrived_at,
        days_on_road, exceeded_weeks, bonus_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [groupId, driverName || null, unitNumber || null, roadStartedAt, homeArrivedAt,
      daysOnRoad, exceededWeeks, bonusUsd]
  );
  return res.rows[0];
}

/**
 * The still-open home stay for a group: the most recent completed road leg whose
 * home stay has not yet been closed (return_to_road_at IS NULL). This is the row
 * a home→road transition closes with the actual home duration.
 */
async function getOpenHomeStay(groupId) {
  const res = await query(
    `SELECT * FROM driver_road_history
     WHERE group_id = $1 AND return_to_road_at IS NULL
     ORDER BY home_arrived_at DESC LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

/**
 * Close a home stay: stamp the actual return-to-road time and home duration, and
 * optionally link the decided request that authorized it. Atomic guard on the
 * still-open state so a repeated home→road cannot overwrite a closed stay.
 */
async function closeHomeStay(id, { returnToRoadAt, homeDays, linkedRequestId }) {
  const res = await query(
    `UPDATE driver_road_history
       SET return_to_road_at = $2,
           home_days = $3,
           linked_request_id = COALESCE($4, linked_request_id)
     WHERE id = $1 AND return_to_road_at IS NULL
     RETURNING *`,
    [id, returnToRoadAt, homeDays == null ? null : homeDays,
      linkedRequestId == null ? null : linkedRequestId]
  );
  return res.rows[0] || null;
}

/**
 * Every completed road leg with the driver labels + the status of any linked
 * home-time request, for the efficiency dashboard. `sinceIso` filters on the home
 * arrival (start of the home side of the cycle). The service classifies each row.
 */
async function listCyclesForEfficiency({ sinceIso = null } = {}) {
  const res = await query(
    `SELECT h.id, h.group_id, h.driver_name, h.unit_number,
            h.road_started_at, h.home_arrived_at, h.return_to_road_at,
            h.days_on_road, h.home_days, h.exceeded_weeks, h.bonus_usd,
            h.linked_request_id,
            g.group_name, g.active AS group_active,
            dp.first_name, dp.last_name, dp.unit_number AS profile_unit_number,
            dp.driver_type, dp.status AS driver_status,
            req.status AS linked_request_status,
            req.home_from AS req_home_from, req.return_to_road_date AS req_return_to_road_date, req.home_to AS req_home_to
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
     LEFT JOIN home_time_requests req ON req.id = h.linked_request_id
     WHERE ($1::timestamptz IS NULL OR h.home_arrived_at >= $1)
     ORDER BY h.home_arrived_at DESC`,
    [sinceIso]
  );
  return res.rows;
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

/** Current state of every tracked driver group, with the group/driver labels. */
async function listCurrentStatuses() {
  const res = await query(
    `SELECT s.*, g.group_name, g.active AS group_active,
            dp.first_name, dp.last_name, dp.unit_number, dp.status AS driver_status, dp.driver_type
     FROM driver_home_status s
     JOIN groups g ON g.id = s.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = s.group_id
     ORDER BY s.state_since ASC`
  );
  return res.rows;
}

/**
 * Completed road legs that earned an extra-week bonus but whose one-time summary
 * has NOT yet been posted to the Extra Week / Road Bonus group. Oldest first so
 * catch-up posts keep chronological order. Backs the idempotent road→home
 * summary flow (services/roadBonusNotifierService.js).
 */
async function listUnpostedRoadBonuses({ limit = 100 } = {}) {
  const res = await query(
    `SELECT h.*, g.group_name, g.telegram_group_id, dp.driver_type
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
     WHERE h.bonus_usd > 0 AND h.bonus_posted_at IS NULL
     ORDER BY h.home_arrived_at ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/**
 * Atomically claim a completed leg for its bonus summary post: stamps
 * bonus_posted_at only if it was still NULL. Returns the row when THIS caller won
 * the claim, or null if it was already posted/claimed — the idempotency guard
 * that prevents duplicate summaries across restarts, syncs and status updates.
 */
async function claimRoadBonusPost(id) {
  const res = await query(
    `UPDATE driver_road_history
       SET bonus_posted_at = NOW()
     WHERE id = $1 AND bonus_posted_at IS NULL
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/** Release a claim (e.g. the Telegram send failed) so a later pass retries it. */
async function unclaimRoadBonusPost(id) {
  const res = await query(
    `UPDATE driver_road_history
       SET bonus_posted_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/** Recent completed road trips (most recent first). */
async function listRoadHistory({ limit = 100, bonusOnly = false } = {}) {
  const where = bonusOnly ? 'WHERE bonus_usd > 0' : '';
  const res = await query(
    `SELECT h.*, g.group_name, dp.driver_type
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
     ${where}
     ORDER BY h.home_arrived_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function getRoadHistoryById(id) {
  const res = await query(
    `SELECT h.*, g.group_name, dp.driver_type
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
     WHERE h.id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

/** Admin edit of a completed trip's dates + recomputed bonus fields. */
async function updateRoadHistory(id, {
  roadStartedAt, homeArrivedAt, daysOnRoad, exceededWeeks, bonusUsd,
}) {
  const res = await query(
    `UPDATE driver_road_history
       SET road_started_at = $2, home_arrived_at = $3,
           days_on_road = $4, exceeded_weeks = $5, bonus_usd = $6
     WHERE id = $1 RETURNING *`,
    [id, roadStartedAt, homeArrivedAt, daysOnRoad, exceededWeeks, bonusUsd]
  );
  return res.rows[0] || null;
}

async function deleteRoadHistory(id) {
  const res = await query('DELETE FROM driver_road_history WHERE id = $1 RETURNING id', [id]);
  return res.rows.length > 0;
}

/** Admin edit of the current state's start date (keeps state, moves the clock). */
async function setDriverHomeStateSince(groupId, stateSince) {
  const res = await query(
    `UPDATE driver_home_status
       SET state_since = $2, updated_at = NOW()
     WHERE group_id = $1 RETURNING *`,
    [groupId, stateSince]
  );
  return res.rows[0] || null;
}

/**
 * Admin override of the current state ('home' | 'road') and/or its start date.
 * Each field is optional; a null leaves that column untouched (COALESCE). Used by
 * the admin panel so a wrong/auto-detected state can be corrected by hand.
 */
async function setDriverHomeState(groupId, { state, stateSince } = {}) {
  const res = await query(
    `UPDATE driver_home_status
       SET state = COALESCE($2, state),
           state_since = COALESCE($3, state_since),
           updated_at = NOW()
     WHERE group_id = $1 RETURNING *`,
    [groupId, state || null, stateSince || null]
  );
  return res.rows[0] || null;
}

// ─── Home-time requests ───

// Open clarification flows still waiting on the driver for one or both dates.
// Single source of truth lives with the clarification worker that guards on it.
const { AWAITING_STATUSES } = clarification;
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

// ─── Bot access settings (super admin) ───

async function getBotAccessSettings() {
  const res = await query('SELECT * FROM bot_access_settings WHERE id = 1');
  return res.rows[0] || null;
}

async function updateBotAccessSettings({ superAdminTelegramId, superAdminLabel }) {
  const res = await query(
    `UPDATE bot_access_settings
       SET super_admin_telegram_id = $1,
           super_admin_label = $2,
           updated_at = NOW()
     WHERE id = 1 RETURNING *`,
    [superAdminTelegramId == null ? null : String(superAdminTelegramId), superAdminLabel || null]
  );
  return res.rows[0] || null;
}

module.exports = {
  AWAITING_STATUSES,
  OPEN_CLARIFICATION_STATUSES,
  OPEN_REQUEST_STATUSES,
  getHomeTimeSettings,
  updateHomeTimeSettings,
  getDriverHomeStatus,
  upsertDriverHomeStatus,
  setRoadBonusWeeksNotified,
  listOnRoadStatuses,
  touchDriverHomeStatus,
  insertRoadHistory,
  listUnpostedRoadBonuses,
  claimRoadBonusPost,
  unclaimRoadBonusPost,
  getOpenHomeStay,
  closeHomeStay,
  listCyclesForEfficiency,
  findDecidedRequestNearDate,
  listCurrentStatuses,
  listRoadHistory,
  getRoadHistoryById,
  updateRoadHistory,
  deleteRoadHistory,
  setDriverHomeStateSince,
  setDriverHomeState,
  insertHomeTimeRequest,
  updateHomeTimeRequestFields,
  getHomeTimeRequestById,
  getPendingHomeTimeRequestForGroup,
  cancelHomeTimeReminderSchedule: clarification.cancelHomeTimeReminderSchedule,
  claimInternalClarificationAlert: clarification.claimInternalClarificationAlert,
  releaseInternalClarificationAlert: clarification.releaseInternalClarificationAlert,
  getOpenHomeTimeRequestForGroup,
  getOpenClarificationForGroup,
  getAwaitingDatesHomeTimeRequestForGroup,
  getApprovedHomeTimeRequestForGroup,
  fulfillAwaitingHomeTimeRequest,
  setHomeTimeClarificationMessage,
  markHomeTimeAcknowledged,
  listDueHomeTimeReminders: clarification.listDueHomeTimeReminders,
  claimHomeTimeReminder: clarification.claimHomeTimeReminder,
  markHomeTimeClarificationUnanswered: clarification.markHomeTimeClarificationUnanswered,
  expireOpenClarificationsForGroup,
  decideHomeTimeRequest,
  setHomeTimeRequestMessage,
  findHomeTimeRequestByWindow,
  listHomeTimeRequests,
  getBotAccessSettings,
  updateBotAccessSettings,
};
