/**
 * Cumulative MILES per driver, and persisting that progress.
 *
 * Pulls the Datatruck order window for the pay period and aggregates billable
 * miles per active company driver. This is the input to every bonus decision,
 * so the aggregation rules (which orders count, whether empty miles count, team
 * co-driver credit) live in services/mileageBonusConstants.js and are applied
 * here rather than restated anywhere else.
 *
 * Split out of services/mileageBonusService.js, which re-exports
 * computeDriverMileage.
 */
const { DateTime } = require('luxon');
const mb = require('../../database/mileageBonus');
const datatruck = require('../datatruckApiService');
const { getOrderPickupIso, tripMiles } = require('./runHelpers');
const {
  PROGRAM_START_ISO, SCHEDULE_TIMEZONE, CREDIT_TEAM_CO_DRIVER, normalizeDriverName,
  computePayPeriodEnd, driverPeriodStart, tiersReached, nextTier,
} = require('../mileageBonusConstants');

/**
 * Fetch + aggregate cumulative miles per active company driver.
 * @param {DateTime} referenceDate  Central datetime anchoring the pay period.
 * @returns {{ periodEnd: DateTime, drivers: Array }}
 */
async function computeDriverMileage(referenceDate, { inactiveKeys = new Set() } = {}) {
  const periodEnd = computePayPeriodEnd(referenceDate);
  const programStart = DateTime.fromISO(PROGRAM_START_ISO, { zone: SCHEDULE_TIMEZONE }).startOf('day');
  const startIso = programStart.toUTC().toISO();
  const endIso = periodEnd.toUTC().toISO();

  const driverRows = await datatruck.fetchAllDrivers();
  const companyByName = new Map();
  for (const d of driverRows) {
    if (d.driver_type !== 'company_driver') continue;
    const fullName = d.account?.full_name
      || [d.account?.first_name, d.account?.last_name].filter(Boolean).join(' ');
    const normalized = normalizeDriverName(fullName);
    if (!normalized) continue;
    if (inactiveKeys.has(normalized)) continue;
    const startDt = driverPeriodStart(d.hire_date);
    companyByName.set(normalized, {
      externalId: d.id != null ? String(d.id) : null,
      name: fullName,
      normalizedName: normalized,
      hireDate: d.hire_date || null,
      periodStartDt: startDt,
      periodStartMs: startDt.toMillis(),
      periodStartIso: startDt.toISODate(),
      totalMiles: 0,
      trips: 0,
    });
  }

  const orders = await datatruck.fetchOrdersByPickupWindow(startIso, endIso);
  for (const order of orders) {
    const pickupIso = getOrderPickupIso(order);
    if (!pickupIso) continue;
    const pickupMs = DateTime.fromISO(pickupIso, { zone: 'utc' }).toMillis();
    if (!Number.isFinite(pickupMs)) continue;
    const miles = tripMiles(order);
    if (miles <= 0) continue;

    const trip = order.trip || {};
    const candidates = [trip.driver__full_name];
    if (CREDIT_TEAM_CO_DRIVER && trip.team_driver__full_name) {
      candidates.push(trip.team_driver__full_name);
    }
    for (const candidate of candidates) {
      const driver = companyByName.get(normalizeDriverName(candidate));
      if (!driver) continue;
      if (pickupMs < driver.periodStartMs) continue; // before this driver started counting
      driver.totalMiles += miles;
      driver.trips += 1;
    }
  }

  const periodEndDate = periodEnd.toISODate();
  const drivers = [...companyByName.values()].map((d) => {
    const reached = tiersReached(d.totalMiles);
    const highest = reached.length ? reached[reached.length - 1].miles : null;
    const next = nextTier(d.totalMiles);
    return {
      ...d,
      totalMiles: Math.round(d.totalMiles * 100) / 100,
      periodEndIso: periodEndDate,
      tiersReached: reached,
      highestTier: highest,
      nextTier: next ? next.miles : null,
      milesToNextTier: next ? Math.round((next.miles - d.totalMiles) * 100) / 100 : null,
    };
  }).sort((a, b) => b.totalMiles - a.totalMiles);

  return { periodEnd, periodEndDate, drivers };
}

async function persistProgress(drivers) {
  for (const d of drivers) {
    await mb.upsertDriverProgress({
      driver_external_id: d.externalId,
      driver_normalized_name: d.normalizedName,
      driver_name: d.name,
      driver_type: 'company_driver',
      hire_date: d.hireDate,
      period_start: d.periodStartIso,
      period_end: d.periodEndIso,
      total_miles: d.totalMiles,
      trips: d.trips,
      highest_tier_reached: d.highestTier,
      next_tier: d.nextTier,
      miles_to_next_tier: d.milesToNextTier,
    });
  }
}

module.exports = {
  computeDriverMileage,
  persistProgress,
};
