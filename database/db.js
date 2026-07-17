const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { pool, query, ping } = require('./pool');

// Feature modules extracted from this file. db.js stays the compatibility
// seam: it re-exports every helper below so existing `require('./db')` /
// `require('../database/db')` callers keep working unchanged. New code may
// require the feature modules directly. These modules depend only on
// ./pool (groupMembers additionally on ./driverProfiles) — never back on
// db.js — so the require graph stays acyclic.
const groupsDb = require('./groups');
const driverProfilesDb = require('./driverProfiles');
const driversDb = require('./drivers');
const groupMembersDb = require('./groupMembers');
const questionsDb = require('./questions');
const dispatchEtaDb = require('./dispatchEta');
const fuelMonitoringDb = require('./fuelMonitoring');
const scheduledMessagesDb = require('./scheduledMessages');
const broadcastsDb = require('./broadcasts');
const leadsDb = require('./leads');
const chatLogsDb = require('./chatLogs');
const aiReportsDb = require('./aiReports');
const employeeBirthdaysDb = require('./employeeBirthdays');
const facebookLeadsDb = require('./facebookLeads');
const trailersDb = require('./trailers');
const trailerMasterListDb = require('./trailerMasterList');
const rbacDb = require('./rbac');
const trailerCompaniesDb = require('./trailerCompanies');
const trailerRentalsDb = require('./trailerRentals');
const trailerMediaDb = require('./trailerMedia');
const trailerFinanceDb = require('./trailerFinance');
const trailerNotificationsDb = require('./trailerNotifications');
const trailerAuditDb = require('./trailerAudit');
const trailerAssetsDb = require('./trailerAssets');
const trailerReportsDb = require('./trailerReports');
const trailerAgreementsDb = require('./trailerAgreements');
const trailerCreditsDb = require('./trailerCredits');

/**
 * Initialize database tables from schema.sql
 */
async function initializeDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  try {
    await pool.query(schema);
    console.log('[DB] Database tables verified/created.');

    // Auto-tag employee group if EMPLOYEE_GROUP_ID is set
    if (config.employeeGroupId) {
      await pool.query(
        `UPDATE groups SET group_type = 'employee' WHERE telegram_group_id = $1 AND group_type != 'employee'`,
        [config.employeeGroupId]
      );
    }

    await facebookLeadsDb.seedFacebookLeadAutoMessageDefaults();

    await pool.query(
      `UPDATE groups SET status_source = 'bot'
       WHERE group_type = 'driver' AND status_source IS NULL`
    );

    await employeeBirthdaysDb.ensureEmployeeBirthdaySettings();
  } catch (err) {
    console.error('[DB] Error initializing database:', err.message);
    throw err;
  }
}


// ─── Admins ───

async function getAdminByUsername(username) {
  const res = await query('SELECT * FROM admins WHERE username = $1', [username]);
  return res.rows[0];
}

async function createAdmin(username, passwordHash) {
  const res = await query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO NOTHING
     RETURNING *`,
    [username, passwordHash]
  );
  return res.rows[0] || getAdminByUsername(username);
}

// ─── Service Run Guard (daily/weekly idempotency) ───
// Claim a logical run so a scheduled task fires exactly once per key
// across restarts and (future) multi-instance deployments.
// Returns `true` if this call successfully claimed the run.
async function claimServiceRun(serviceName, runKey) {
  const res = await query(
    `INSERT INTO service_runs (service_name, run_key)
     VALUES ($1, $2)
     ON CONFLICT (service_name, run_key) DO NOTHING
     RETURNING id`,
    [serviceName, runKey]
  );
  return res.rows.length > 0;
}

async function hasServiceRun(serviceName, runKey) {
  const res = await query(
    'SELECT 1 FROM service_runs WHERE service_name = $1 AND run_key = $2',
    [serviceName, runKey]
  );
  return res.rows.length > 0;
}

// Release a previously-claimed run so it can be retried. Used when a job
// claims a run and then fails to deliver: releasing the claim lets the next
// scheduler tick retry that same day instead of treating the run as
// permanently done (which previously silently dropped birthday wishes).
// Returns `true` if a row was actually removed.
async function unclaimServiceRun(serviceName, runKey) {
  const res = await query(
    'DELETE FROM service_runs WHERE service_name = $1 AND run_key = $2',
    [serviceName, runKey]
  );
  return res.rowCount > 0;
}


// ─── Bot visibility diagnostics ───

// Record that the bot RECEIVED a message from a group. This is the ground-truth
// signal that the bot can actually read the group (privacy mode off / it is an
// admin). Only advances the timestamp forward so out-of-order events are safe.
async function recordGroupMessageSeen(groupId, seenAtIso) {
  try {
    await query(
      `UPDATE groups
       SET last_message_seen_at = $2
       WHERE id = $1
         AND (last_message_seen_at IS NULL OR last_message_seen_at < $2)`,
      [groupId, seenAtIso]
    );
  } catch (err) {
    // Non-fatal: this is a diagnostic signal, never block message handling.
    console.error('[DB] recordGroupMessageSeen failed:', err.message);
  }
}

// Cache the bot's membership role in a group (from Telegram getChatMember).
async function updateGroupBotAccess(groupId, memberStatus, checkedAtIso) {
  const res = await query(
    `UPDATE groups
     SET bot_member_status = $2, bot_access_checked_at = $3
     WHERE id = $1 RETURNING id`,
    [groupId, memberStatus || null, checkedAtIso]
  );
  return res.rows.length > 0;
}

async function listGroupDirectorySourceRows({ includeNonDrivers = true } = {}) {
  const typeClause = includeNonDrivers ? '' : `WHERE g.group_type = 'driver'`;
  const res = await query(
    `SELECT
        g.id AS group_id,
        g.group_name,
        g.telegram_group_id,
        g.group_type,
        g.active AS group_active,
        g.status_source,
        g.status_updated_at,
        g.language AS group_language,
        g.driver_birthday AS group_driver_birthday,
        g.created_at AS group_created_at,
        g.last_message_seen_at,
        g.bot_member_status,
        g.bot_access_checked_at,
        dp.id AS profile_id,
        dp.first_name,
        dp.last_name,
        dp.secondary_first_name,
        dp.secondary_last_name,
        dp.first_name_source,
        dp.last_name_source,
        dp.secondary_first_name_source,
        dp.secondary_last_name_source,
        dp.driver_type,
        dp.driver_type_source,
        dp.status AS profile_status,
        dp.unit_number,
        dp.unit_number_source,
        dp.language AS profile_language,
        dp.date_of_birth,
        dp.date_of_start,
        dp.needs_review,
        dp.backfill_confidence,
        dp.telegram_username,
        dp.telegram_user_id,
        dp.created_at AS profile_created_at,
        dp.updated_at AS profile_updated_at,
        s.state AS home_state,
        s.state_since,
        s.last_status_text,
        s.last_status_at
     FROM groups g
     LEFT JOIN driver_profiles dp ON dp.group_id = g.id
     LEFT JOIN driver_home_status s ON s.group_id = g.id
     ${typeClause}
     ORDER BY g.group_name ASC, g.id ASC`
  );
  return res.rows;
}

// Driver groups with their bot-visibility signals, joined to the driver label
// and the home-time state, for the admin "Bot Group Access" view.
async function listDriverGroupAccess() {
  const res = await query(
    `SELECT g.id AS group_id,
            g.group_name,
            g.telegram_group_id,
            g.group_type,
            g.active,
            g.last_message_seen_at,
            g.bot_member_status,
            g.bot_access_checked_at,
            dp.first_name, dp.last_name, dp.unit_number, dp.status AS driver_status,
            s.state AS home_state, s.last_status_at
     FROM groups g
     LEFT JOIN driver_profiles dp ON dp.group_id = g.id
     LEFT JOIN driver_home_status s ON s.group_id = g.id
     WHERE g.group_type = 'driver'
     ORDER BY g.group_name ASC, g.id ASC`
  );
  return res.rows;
}

// Same as listDriverGroupAccess but for EVERY group (driver + non-driver), so the
// admin can filter the Bot Group Access view by type and active state.
async function listAllGroupAccess() {
  const res = await query(
    `SELECT g.id AS group_id,
            g.group_name,
            g.telegram_group_id,
            g.group_type,
            g.active,
            g.last_message_seen_at,
            g.bot_member_status,
            g.bot_access_checked_at,
            dp.first_name, dp.last_name, dp.unit_number, dp.status AS driver_status,
            s.state AS home_state, s.last_status_at
     FROM groups g
     LEFT JOIN driver_profiles dp ON dp.group_id = g.id
     LEFT JOIN driver_home_status s ON s.group_id = g.id
     ORDER BY g.group_name ASC, g.id ASC`
  );
  return res.rows;
}


module.exports = {
  pool,
  query,
  ping,
  initializeDatabase,
  // Admins
  getAdminByUsername,
  createAdmin,
  // Service run guard
  claimServiceRun,
  hasServiceRun,
  unclaimServiceRun,
  // Bot visibility diagnostics
  recordGroupMessageSeen,
  updateGroupBotAccess,
  listGroupDirectorySourceRows,
  listDriverGroupAccess,
  listAllGroupAccess,
  // Feature modules (extracted from this file; same helper names as before)
  ...groupsDb,
  ...driverProfilesDb,
  ...driversDb,
  ...groupMembersDb,
  ...questionsDb,
  ...dispatchEtaDb,
  ...fuelMonitoringDb,
  ...scheduledMessagesDb,
  ...broadcastsDb,
  ...leadsDb,
  ...chatLogsDb,
  ...aiReportsDb,
  ...employeeBirthdaysDb,
  ...facebookLeadsDb,
  ...trailersDb,
  ...trailerMasterListDb,
  ...rbacDb,
  ...trailerCompaniesDb,
  ...trailerRentalsDb,
  ...trailerMediaDb,
  ...trailerFinanceDb,
  ...trailerNotificationsDb,
  ...trailerAuditDb,
  ...trailerAssetsDb,
  ...trailerReportsDb,
  ...trailerAgreementsDb,
  ...trailerCreditsDb,
};
