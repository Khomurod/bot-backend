'use strict';

/**
 * Monitoring → Logs, read side (super administrators only — the route
 * guards it). A page of entries, newest first, with a link to each Bitrix
 * record. docs/architecture/activity-log.md.
 *
 * Filters are checked here, not trusted: a date is an ISO date, a feature
 * key and a result come from a closed shape, a search is short. Nothing an
 * entry could not already hold is returned — the stored entry never carries
 * a secret (lib/activityLog/entry.js) — and a link is built from the
 * portal's ORIGIN only, never the webhook URL.
 */

const { RESULTS } = require('../../lib/activityLog/entry');
const { TRIGGER_LABELS } = require('../../lib/activityLog/failureStreak');

function defaultDeps() {
  /* eslint-disable global-require */
  const stages = require('../bitrix24DealStages');
  return {
    store: require('../../database/activityLog'),
    portalOrigin: stages.portalOrigin,
  };
  /* eslint-enable global-require */
}

class FilterError extends Error {}

function isoOrNull(value, name) {
  if (value == null || value === '') return null;
  const t = Date.parse(String(value));
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(value)) || !Number.isFinite(t)) throw new FilterError(`"${name}" must be a date`);
  return new Date(t).toISOString();
}

/** The filters a request may carry, checked. Throws FilterError (a 400). */
function readFilters(q = {}) {
  const trigger = q.trigger ? String(q.trigger) : null;
  if (trigger && !/^[a-z0-9_.]{1,80}$/.test(trigger)) throw new FilterError('Unknown feature');
  const result = q.result ? String(q.result) : null;
  if (result && !RESULTS.includes(result)) throw new FilterError('Unknown result');
  const search = q.search ? String(q.search).trim().slice(0, 80) : null;
  const before = q.before ? String(q.before).slice(0, 80) : null;
  if (before && !/^[0-9TZ:.+\- ]+~\d{1,18}$/.test(before)) throw new FilterError('Bad page cursor');
  return {
    from: isoOrNull(q.from, 'from'), to: isoOrNull(q.to, 'to'), trigger, result, search, before,
  };
}

/** Where a record opens in Bitrix, or null. */
function linkFor(origin, entry) {
  if (!origin || entry.system !== 'bitrix' || !/^\d+$/.test(String(entry.targetId || ''))) return null;
  const id = Number(entry.targetId);
  if (entry.targetType === 'deal') return `${origin}/crm/deal/details/${id}/`;
  if (entry.targetType === 'contact') return `${origin}/crm/contact/details/${id}/`;
  if (entry.targetType === 'lead') return `${origin}/crm/lead/details/${id}/`;
  return null;
}

/**
 * @param {object} query  the request's query string
 * @returns {Promise<{entries: object[], nextCursor: string|null, triggers: object[], pageSize: number}>}
 */
async function listActivity(query, deps = defaultDeps()) {
  const filters = readFilters(query);
  const page = await deps.store.listEntries(filters);
  const origin = await Promise.resolve(deps.portalOrigin?.()).catch(() => null);
  return {
    entries: page.entries.map((e) => ({ ...e, link: linkFor(origin, e) })),
    nextCursor: page.nextCursor,
    triggers: Object.entries(TRIGGER_LABELS).map(([key, label]) => ({ key, label })),
    pageSize: deps.store.PAGE_SIZE || 50,
  };
}

module.exports = {
  listActivity, readFilters, linkFor, FilterError,
};
