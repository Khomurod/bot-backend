/**
 * Resolve broadcast/scheduled target groups with optional active/inactive filter.
 * Default filter is "active" so behavior matches legacy getAllDriverGroups paths.
 */
const db = require('../database/db');

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
    return source.filter((g) => g.group_name && g.group_name.includes('(COMPANY DRIVER)'));
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
