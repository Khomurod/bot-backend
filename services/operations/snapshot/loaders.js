'use strict';

/**
 * The sweep's one read of the world.
 *
 * SPLIT OUT OF `consistencyService.js` DELIBERATELY. That file had reached 396
 * lines with two responsibilities inside it — orchestration, and a hundred
 * lines of SQL that grows by a query every time a check learns about a new
 * table. The orchestration is the part people read; the queries are the part
 * that keeps growing. Separating them means adding a source to the snapshot no
 * longer walks the sweep towards the 500-line cap.
 *
 * ONE SNAPSHOT, ONE MOMENT. Every check sees the same rows read at the same
 * time — the invariant `consistencyService.js` states in full.
 *
 * Deliberately plain SELECTs rather than the data-layer helpers: several of
 * those auto-seed rows on read (`listDriverProfiles` creates a missing
 * profile), and a read-only sweep must not write.
 */
const defaultDb = require('../../../database/pool');
const { getBoardRowsForSnapshot } = require('../../../database/dispatchBoard');

/** Everything the checks need, read once. */
async function loadSnapshot(db = defaultDb) {
  const [groups, profiles, roadHistory, homeStatus, settings, exhausted, layer, boardRows] = await Promise.all([
    db.query(
      `SELECT id, group_name, group_type, active, status_source, status_updated_at,
              bot_member_status, bot_access_checked_at, last_message_seen_at, samsara_vehicle_id
         FROM groups`
    ),
    db.query(
      // `driver_type` IS NOT OPTIONAL HERE. Every fleet-aware check calls
      // `resolveDriverType({column: profile.driver_type, title: group_name})`,
      // whose whole rule is that the STORED COLUMN WINS and the title is only
      // the fallback when it is NULL. Leaving the column out of this SELECT
      // made `column` undefined for every row, so the fallback ran every time
      // and the rule A3b shipped was inert — a chat titled without
      // "(COMPANY DRIVER)" read as owner_operator no matter what an
      // administrator had recorded, and the contest check then compared it
      // against a unit row that held the real value and found two different
      // fleets where there was one.
      `SELECT group_id, first_name, last_name, secondary_first_name, secondary_last_name,
              unit_number, status, telegram_user_id, driver_type
         FROM driver_profiles`
    ),
    // Open cycles, plus every cycle of any group that has one — the class-B rule
    // needs a cycle's NEIGHBOURS, not just the open row itself.
    db.query(
      `SELECT id, group_id, road_started_at, home_arrived_at, return_to_road_at, home_days
         FROM driver_road_history
        WHERE group_id IN (SELECT group_id FROM driver_road_history WHERE return_to_road_at IS NULL)
        ORDER BY group_id, home_arrived_at`
    ),
    db.query('SELECT group_id, state, state_since, last_status_at, road_bonus_weeks_notified FROM driver_home_status'),
    db.query('SELECT home_allowance_days, road_allowance_weeks FROM home_time_settings WHERE id = 1'),
    // The exhausted internal-alert pile. Ids and the recorded error only — never
    // the alert BODY, which is driver correspondence and has no business in a
    // finding's evidence.
    db.query(
      `SELECT id, requested_at, internal_alert_last_error
         FROM home_time_requests
        WHERE internal_alert_state = 'failed'
        ORDER BY requested_at ASC`
    ),
    loadLayerSnapshot(db),
    loadBoardSnapshot(db),
  ]);

  return {
    now: new Date(),
    groups: groups.rows,
    groupsById: new Map(groups.rows.map((g) => [g.id, g])),
    profiles: profiles.rows,
    roadHistory: roadHistory.rows,
    homeStatus: homeStatus.rows,
    settings: settings.rows[0] || {},
    exhaustedInternalAlerts: {
      count: exhausted.rows.length,
      oldestAt: exhausted.rows[0]?.requested_at || null,
      requestIds: exhausted.rows.map((r) => r.id),
      lastError: exhausted.rows[0]?.internal_alert_last_error || null,
    },
    boardRows,
    ...layer,
  };
}

/**
 * The person layer and the systems that hang off it (Phase 3-F). Only what the
 * checks compare — ids, states and links; never message text or alert bodies.
 */
async function loadLayerSnapshot(db) {
  const [
    people, personGroups, units, fuelAlerts, groupMembers, botUsers, telegramIdentities,
    teamDrivers, mileageProgress,
    routeAssignments, personGroupHistory, notificationSettings,
  ] = await Promise.all([
    db.query('SELECT id, display_name, merged_into_person_id FROM driver_people'),
    db.query('SELECT person_id, group_id, started_at FROM driver_person_groups WHERE ended_at IS NULL'),
    // FLEET AND SEAT TRAVEL WITH THE UNIT. Migration 0047 made a truck
    // `(fleet_type, unit_number, seat)` and this query kept selecting the bare
    // number, so every check reading it saw Company 001 and Lease 001 as one
    // truck — the exact confusion 0047 exists to remove.
    db.query(
      `SELECT person_id, unit_number, samsara_vehicle_id, fleet_type, seat
         FROM driver_units WHERE ended_at IS NULL`
    ),
    db.query(`SELECT id, group_id, status, created_at FROM fuel_stop_alerts WHERE status = 'watching'`),
    // Who the bot has seen in each chat, what role it guessed for them, and
    // which accounts are already spoken for. The last two are wrapped: a deploy
    // that has not applied 0049 costs the Telegram-identity checks and not the
    // whole sweep.
    db.query('SELECT group_id, telegram_user_id, username, first_name, last_name FROM group_members'),
    db.query('SELECT telegram_user_id, source FROM bot_users').catch(() => ({ rows: [] })),
    db.query(
      'SELECT person_id, telegram_user_id, ended_at FROM driver_person_telegram_identities'
    ).catch(() => ({ rows: [] })),
    db.query(
      `SELECT id, team_id, group_id, driver_profile_id, person_id, driver_name, active
         FROM dispatch_team_drivers WHERE active = TRUE`
    ),
    db.query('SELECT id, driver_normalized_name, person_id FROM mileage_bonus_progress WHERE is_active = TRUE'),
    db.query(`SELECT id, group_id, status, created_at FROM route_assignments WHERE status = 'active'`),
    // Open AND closed: the continuity check needs to know which chat a person
    // was on BEFORE the one they are on now.
    db.query('SELECT person_id, group_id, started_at, ended_at FROM driver_person_groups ORDER BY started_at'),
    // Where Wenze's notices go. A plain SELECT rather than the settings helper
    // for the reason stated above the other queries here: the data-layer
    // helpers seed a row on read, and a SWEEP MUST NOT WRITE. A missing table
    // (a deploy in progress) answers with no rows and the check stands down.
    db.query('SELECT enabled, default_chat_id, category_chat_ids FROM operational_notification_settings WHERE id = 1')
      .catch(() => ({ rows: [] })),
  ]);
  return {
    people: people.rows,
    personGroups: personGroups.rows,
    personGroupHistory: personGroupHistory.rows,
    units: units.rows,
    fuelAlerts: fuelAlerts.rows,
    groupMembers: groupMembers.rows,
    botUsers: botUsers.rows,
    telegramIdentities: telegramIdentities.rows,
    linkedTelegramUserIds: new Set(
      telegramIdentities.rows.filter((r) => r.ended_at == null).map((r) => String(r.telegram_user_id))
    ),
    teamDrivers: teamDrivers.rows,
    mileageProgress: mileageProgress.rows,
    routeAssignments: routeAssignments.rows,
    notificationSettings: notificationSettings.rows[0]
      ? {
        enabled: notificationSettings.rows[0].enabled !== false,
        defaultChatId: notificationSettings.rows[0].default_chat_id,
        categoryChatIds: notificationSettings.rows[0].category_chat_ids || {},
      }
      : null,
  };
}

/**
 * The Dispatcher Board snapshot.
 *
 * The query itself belongs to `database/dispatchBoard.js`, which owns that
 * table; this passes the sweep's own `db` into it so every check still reads one
 * database at one moment. Writing the SELECT again here would be a second copy
 * of a column list that has to stay in step with the checks, and the two had
 * already drifted once.
 *
 * A MISSING TABLE IS NOT AN OUTAGE, and is the only failure swallowed here.
 * Migrations run inside `initializeDatabase()` at boot, so the only way
 * `dispatch_board_rows` is absent is a deploy that has not applied 0046 yet —
 * during which the board checks should stand down rather than take the whole
 * sweep with them. Every OTHER error (a permission problem, a dead connection)
 * propagates, because those are real and hiding them is how a sweep reports
 * "nothing wrong" about a database it cannot read.
 */
async function loadBoardSnapshot(db) {
  try {
    return await getBoardRowsForSnapshot(db);
  } catch (err) {
    if (err && err.code === '42P01') return [];
    throw err;
  }
}

module.exports = { loadSnapshot, loadLayerSnapshot, loadBoardSnapshot };
