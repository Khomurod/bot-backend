/**
 * Resolve broadcast/scheduled target groups with optional active/inactive filter.
 * Default filter is "active" so behavior matches legacy getAllDriverGroups paths.
 */
const db = require('../database/db');
const { inferDriverType } = require('../lib/drivers/driverProfileParse');

function normalizeActiveFilter(body) {
  const f = body?.target_active_filter;
  if (f === 'all' || f === 'inactive') return f;
  return 'active';
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
    const source = filter === 'active'
      ? await db.getAllDriverGroups()
      : await db.getDriverGroupsByActiveFilter(filter);
    // `inferDriverType`, not a literal substring. The literal was
    // '(COMPANY DRIVER)' — with the closing bracket — so every group titled
    // '(COMPANY DRIVERS)' was silently excluded from every company-driver
    // broadcast. `/company\s+drivers?/i` is the test the rest of the
    // application already uses, and it handles both.
    return source.filter((g) => inferDriverType(g.group_name) === 'company_driver');
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
  normalizeActiveFilter,
  resolveBroadcastTargetGroups,
};
