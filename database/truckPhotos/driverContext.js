'use strict';

/**
 * Who the driver of a group is, as far as Truck Photos needs to know: the
 * profile (for the PDF's cover) and the driver's Telegram accounts (for "the
 * driver does not mark their own hand-over", lib/truckPhotos/whoMayMark.js).
 *
 * THE DRIVER'S ACCOUNTS are every OPEN `driver_person_telegram_identities` row
 * of the person on this chat, plus the profile's own `telegram_user_id` — the
 * two places Wenze records "this account is this driver"
 * (docs/architecture/telegram-identity.md). Never a username.
 *
 * SOLO OR TEAM is decided the way the identity sweep decides it: a profile
 * that names a second driver is a team chat. No profile at all is UNKNOWN
 * (`isTeam: null`), which whoMayMark reads as "anybody may mark".
 *
 * A table that does not exist yet (42P01) reads as "nothing known"; any other
 * failure is thrown, and the caller treats it as unknown too.
 */

const { query } = require('../pool');

const UNDEFINED_TABLE = '42P01';

async function readProfile(groupId) {
  const { rows } = await query(
    `SELECT first_name, last_name, secondary_first_name, secondary_last_name, unit_number,
            driver_type, truck_fleet, truck_owner, telegram_user_id
       FROM driver_profiles WHERE group_id = $1`,
    [groupId],
  );
  return rows[0] || null;
}

async function readOpenAccounts(groupId) {
  try {
    const { rows } = await query(
      `SELECT DISTINCT t.telegram_user_id
         FROM driver_person_groups pg
         JOIN driver_person_telegram_identities t
           ON t.person_id = pg.person_id AND t.ended_at IS NULL
        WHERE pg.group_id = $1 AND pg.ended_at IS NULL`,
      [groupId],
    );
    return rows.map((r) => String(r.telegram_user_id));
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

/**
 * @param {number} groupId
 * @returns {Promise<{profile: object|null, accountIds: string[], isTeam: boolean|null}>}
 */
async function readDriverContext(groupId) {
  const [profile, accounts] = await Promise.all([readProfile(groupId), readOpenAccounts(groupId)]);
  const accountIds = new Set(accounts);
  if (profile?.telegram_user_id !== null && profile?.telegram_user_id !== undefined) {
    accountIds.add(String(profile.telegram_user_id));
  }
  const isTeam = profile
    ? Boolean(profile.secondary_first_name || profile.secondary_last_name)
    : null;
  return { profile, accountIds: [...accountIds], isTeam };
}

module.exports = { readDriverContext };
