/**
 * Resolve broadcast/scheduled target groups with optional active/inactive filter.
 * Default filter is "active" so behavior matches legacy getAllDriverGroups paths.
 */
const db = require('../database/db');
const { inferDriverType } = require('../lib/drivers/driverProfileParse');
const {
  resolveDriverType, fleetTypeFromGroupName, FLEET_TYPES,
} = require('../lib/drivers/fleetType');

function normalizeActiveFilter(body) {
  const f = body?.target_active_filter;
  if (f === 'all' || f === 'inactive') return f;
  return 'active';
}

/**
 * Does a company-driver broadcast reach this group?
 *
 * THE COSTLY MISTAKE HERE IS DROPPING SOMEBODY. A driver who quietly stops
 * receiving company broadcasts produces no error and no complaint until
 * something important is missed, so this rule is built so that no parsing change
 * can exclude a group the previous rule included. Only an explicit human
 * decision can.
 *
 *   A RECORDED `driver_type` DECIDES. Somebody set it on the profile; a chat
 *   name is a string a dispatcher typed and may have edited since. This is the
 *   one thing that can newly EXCLUDE a group — a title saying COMPANY whose
 *   profile says owner or lease — and that is the point of recording it.
 *
 *   OTHERWISE THE TITLE DECIDES, BY EITHER READING. `lib/drivers/fleetType.js`
 *   is strict because the Dispatcher Board always parenthesises its labels; a
 *   Telegram title does not have to. `COMPANY DRIVERS` written without brackets
 *   is a company driver's chat, and the permissive test is what the application
 *   has always used. Requiring the strict form here would silently drop any such
 *   group, which is exactly the failure this function is shaped around.
 */
function isCompanyDriverGroup(group) {
  const decided = resolveDriverType({ column: group.driver_type, title: null });
  if (decided.source === 'column') return decided.value === 'company_driver';
  return fleetTypeFromGroupName(group.group_name) === FLEET_TYPES.COMPANY
    || inferDriverType(group.group_name) === 'company_driver';
}

async function resolveBroadcastTargetGroups(body) {
  if (!body.target_type && Array.isArray(body.group_ids) && body.group_ids.length > 0) {
    return db.getGroupsByIds(body.group_ids);
  }

  const tt = body.target_type || 'all';
  const filter = normalizeActiveFilter(body);

  if (tt === 'specific_drivers') {
    const ids = body.target_driver_ids;
    if (!Array.isArray(ids) || ids.length === 0) return [];
    return db.getGroupsByIdsForAdmin(ids);
  }

  if (tt === 'language_groups') {
    const langs = body.target_languages;
    if (!Array.isArray(langs) || langs.length === 0) return [];
    if (filter === 'active') {
      return db.getGroupsByLanguages(langs);
    }
    return db.getDriverGroupsByLanguagesAndActiveFilter(langs, filter);
  }

  if (tt === 'company_drivers') {
    const source = await db.getDriverGroupsWithDriverType(filter);
    return source.filter(isCompanyDriverGroup);
  }

  if (tt === 'employee') {
    return db.getGroupsByType('employee', { activeOnly: filter !== 'all' });
  }

  if (tt === 'other_company') {
    return db.getOtherCompanyGroups({ activeOnly: filter !== 'all' });
  }

  if (filter === 'active') {
    return db.getAllDriverGroups();
  }
  return db.getDriverGroupsByActiveFilter(filter);
}

module.exports = {
  isCompanyDriverGroup,
  normalizeActiveFilter,
  resolveBroadcastTargetGroups,
};
