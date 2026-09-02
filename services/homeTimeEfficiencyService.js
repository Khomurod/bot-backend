/**
 * Driver Home-Time Efficiency — pure classification + aggregation (no DB / net).
 *
 * Measures how well drivers follow the company policy (≥ road allowance on the
 * road, ≤ home allowance days at home) using ACTUAL completed cycles from
 * driver_road_history: each row is a road leg (road_started_at → home_arrived_at)
 * plus the home stay that followed (home_arrived_at → return_to_road_at). A cycle
 * is usable for strict efficiency only once the home stay is closed.
 *
 * Categories (per cycle):
 *   - compliant         : road ≥ allowance AND home ≤ allowance.
 *   - approved_exception: broke the policy but a human APPROVED the request.
 *   - non_compliant     : broke the policy with no approval.
 *   - incomplete        : home stay not yet closed (excluded from efficiency).
 *   - not_applicable    : owner operator (company policy does not apply).
 *
 * Strict company efficiency  = compliant ÷ policy-eligible completed cycles.
 * Operational efficiency     = (compliant + approved_exception) ÷ same denominator.
 * (Approved exceptions are surfaced separately so the two percentages are explained.)
 *
 * COMPANY COMMITMENT is a SEPARATE question: when a home window was APPROVED
 * (the registered/approved dates the company agreed to), did what ACTUALLY
 * happened match the promise? — the driver got home by the promised date and
 * returned by the promised return date (both within a small grace). This measures
 * the COMPANY honoring its home-time commitments, not the driver following policy.
 * Cycles with no approved registered dates are `no_commitment` (nothing to judge);
 * cycles whose home stay is still open are `commitment_incomplete` (insufficient
 * data). Neither is counted as met OR broken — see classifyCommitment.
 */
const { DateTime } = require('luxon');
const { homeTimePolicyApplies, DAYS_PER_WEEK } = require('./homeTimeConstants');
const { inferDriverType } = require('../lib/drivers/driverProfileParse');
const { isoDateOnly, resolveRequestReturnDate } = require('./homeTimeDateResolver');

const CATEGORY = {
  COMPLIANT: 'compliant',
  APPROVED_EXCEPTION: 'approved_exception',
  NON_COMPLIANT: 'non_compliant',
  INCOMPLETE: 'incomplete',
  NOT_APPLICABLE: 'not_applicable',
};

// Company-commitment verdicts (approved registered dates vs. what happened).
const COMMITMENT = {
  MET: 'met',
  BROKEN: 'broken',
  INCOMPLETE: 'incomplete', // approved window, but home stay not yet closed
  NONE: 'none',             // no approved registered dates → nothing to measure
  NOT_APPLICABLE: 'not_applicable', // owner operator
};

// Actual home arrival / return may legitimately differ from the promise by a day
// (message timing, timezone). Only a gap LARGER than this breaks the commitment.
const COMMITMENT_GRACE_DAYS = 1;

/** Signed whole-day difference toIso − fromIso for two date-only values; null if unusable. */
function dateDeltaDays(fromIso, toIso) {
  const a = DateTime.fromISO(isoDateOnly(fromIso) || '', { zone: 'utc' });
  const b = DateTime.fromISO(isoDateOnly(toIso) || '', { zone: 'utc' });
  if (!a.isValid || !b.isValid) return null;
  return Math.round(b.diff(a, 'days').days);
}

/**
 * Did the company honor an APPROVED home window for this cycle? Compares the
 * registered/approved dates against what actually happened. PURE.
 *
 * @returns {{ category:string, reasons:string[], promisedHome?:string,
 *   promisedReturn?:string, homeDeltaDays?:number, returnDeltaDays?:number }}
 */
function classifyCommitment(cycle, { graceDays = COMMITMENT_GRACE_DAYS } = {}) {
  const driverType = cycle.driver_type || inferDriverType(cycle.group_name || '');
  if (!homeTimePolicyApplies(driverType)) {
    return { category: COMMITMENT.NOT_APPLICABLE, reasons: [] };
  }
  const promisedHome = isoDateOnly(cycle.req_home_from);
  const promisedReturn = resolveRequestReturnDate({
    return_to_road_date: cycle.req_return_to_road_date, home_to: cycle.req_home_to,
  });
  // A commitment exists only when a human APPROVED a home window.
  if (cycle.linked_request_status !== 'approved' || !promisedHome) {
    return { category: COMMITMENT.NONE, reasons: [] };
  }

  const actualHome = isoDateOnly(cycle.home_arrived_at);
  // + means the driver got home LATER than promised (company kept them out).
  const homeDeltaDays = actualHome ? dateDeltaDays(promisedHome, actualHome) : null;
  if (homeDeltaDays == null) {
    return {
      category: COMMITMENT.INCOMPLETE, reasons: ['no_actual_home'], promisedHome, promisedReturn,
    };
  }
  const reasons = [];
  const homeOnTime = homeDeltaDays <= graceDays;
  if (!homeOnTime) reasons.push('home_late');

  let returnOnTime = true;
  let returnDeltaDays = null;
  if (promisedReturn) {
    const homeClosed = cycle.return_to_road_at != null;
    const actualReturn = isoDateOnly(cycle.return_to_road_at);
    if (!homeClosed || !actualReturn) {
      return {
        category: COMMITMENT.INCOMPLETE, reasons: ['home_stay_open'],
        promisedHome, promisedReturn, homeDeltaDays,
      };
    }
    returnDeltaDays = dateDeltaDays(promisedReturn, actualReturn);
    returnOnTime = returnDeltaDays != null && returnDeltaDays <= graceDays;
    if (!returnOnTime) reasons.push('returned_late');
  }

  return {
    category: (homeOnTime && returnOnTime) ? COMMITMENT.MET : COMMITMENT.BROKEN,
    reasons, promisedHome, promisedReturn, homeDeltaDays, returnDeltaDays,
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify a single completed-cycle row.
 * @param {object} cycle  a driver_road_history row (joined with driver labels + linked request status)
 * @param {object} opts   { roadAllowanceWeeks, homeAllowanceDays }
 */
function classifyCycle(cycle, { roadAllowanceWeeks = 4, homeAllowanceDays = 4 } = {}) {
  const driverType = cycle.driver_type || inferDriverType(cycle.group_name || '');
  const roadDays = num(cycle.days_on_road);
  const homeDays = num(cycle.home_days);
  const homeClosed = cycle.return_to_road_at != null && homeDays != null;
  const allowanceDays = Math.max(0, Number(roadAllowanceWeeks) || 0) * DAYS_PER_WEEK;

  if (!homeTimePolicyApplies(driverType)) {
    return {
      category: CATEGORY.NOT_APPLICABLE, driverType, roadDays, homeDays,
      tooShortRoad: false, tooLongHome: false, reasons: [],
    };
  }
  if (!homeClosed || roadDays == null) {
    return {
      category: CATEGORY.INCOMPLETE, driverType, roadDays, homeDays,
      tooShortRoad: false, tooLongHome: false, reasons: [],
    };
  }

  const tooShortRoad = roadDays < allowanceDays;
  const tooLongHome = homeDays > Math.max(0, Number(homeAllowanceDays) || 0);
  const reasons = [];
  if (tooShortRoad) reasons.push('too_short_road');
  if (tooLongHome) reasons.push('too_long_home');

  if (!tooShortRoad && !tooLongHome) {
    return {
      category: CATEGORY.COMPLIANT, driverType, roadDays, homeDays,
      tooShortRoad, tooLongHome, reasons,
    };
  }
  const approved = cycle.linked_request_status === 'approved';
  return {
    category: approved ? CATEGORY.APPROVED_EXCEPTION : CATEGORY.NON_COMPLIANT,
    driverType, roadDays, homeDays, tooShortRoad, tooLongHome, reasons,
  };
}

function pct(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return Math.round((nums.reduce((s, v) => s + v, 0) / nums.length) * 10) / 10;
}

/**
 * Build the full efficiency report. PURE — the route fetches and passes the data.
 *
 * @param {object} p
 * @param {Array}  p.cycles     driver_road_history rows (ht.listCyclesForEfficiency)
 * @param {Array}  [p.statuses] current per-driver states (ht.listCurrentStatuses shape)
 * @param {Map}    [p.directoryByGroupId]  canonical identity by group id (optional)
 * @param {object} p.settings   home_time_settings row
 */
function buildEfficiencyReport({
  cycles = [], statuses = [], directoryByGroupId = new Map(), settings = {},
} = {}) {
  const roadAllowanceWeeks = Number(settings.road_allowance_weeks) || 4;
  const homeAllowanceDays = Number(settings.home_allowance_days) || 4;
  const opts = { roadAllowanceWeeks, homeAllowanceDays };

  const stateByGroup = new Map();
  for (const s of statuses) {
    const gid = Number(directoryByGroupId.get(Number(s.group_id))?.canonical_group_id || s.group_id);
    if (!stateByGroup.has(gid)) stateByGroup.set(gid, s);
  }

  const drivers = new Map();
  const ensureDriver = (cycle) => {
    const identity = directoryByGroupId.get(Number(cycle.group_id)) || null;
    const gid = Number(identity?.canonical_group_id || cycle.group_id);
    if (!drivers.has(gid)) {
      const driverType = identity?.driver_type || cycle.driver_type || inferDriverType(cycle.group_name || '');
      const state = stateByGroup.get(gid) || null;
      drivers.set(gid, {
        group_id: gid,
        driver_name: identity?.display_name
          || cycle.driver_name
          || [cycle.first_name, cycle.last_name].filter(Boolean).join(' ').trim()
          || cycle.group_name || `Group ${gid}`,
        unit_number: identity?.unit_number || cycle.unit_number || cycle.profile_unit_number || null,
        driver_type: driverType,
        policy_applies: homeTimePolicyApplies(driverType),
        current_state: state?.state || null,
        completed_cycles: 0,
        compliant: 0,
        approved_exceptions: 0,
        non_compliant: 0,
        incomplete: 0,
        too_short_road: 0,
        too_long_home: 0,
        commitment_met: 0,
        commitment_broken: 0,
        commitment_incomplete: 0,
        commitment_none: 0,
        road_days_list: [],
        home_days_list: [],
        latest_cycle_result: null,
        latest_cycle_at: null,
        cycles: [],
      });
    }
    return drivers.get(gid);
  };

  const company = {
    compliant: 0,
    approved_exception: 0,
    non_compliant: 0,
    incomplete: 0,
    not_applicable: 0,
    commitment_met: 0,
    commitment_broken: 0,
    commitment_incomplete: 0,
    commitment_none: 0,
  };

  for (const cycle of cycles) {
    const verdict = classifyCycle(cycle, opts);
    const commitment = classifyCommitment(cycle);
    const d = ensureDriver(cycle);
    company[verdict.category] = (company[verdict.category] || 0) + 1;

    const detail = {
      id: cycle.id,
      road_started_at: cycle.road_started_at,
      home_arrived_at: cycle.home_arrived_at,
      return_to_road_at: cycle.return_to_road_at,
      road_days: verdict.roadDays,
      home_days: verdict.homeDays,
      category: verdict.category,
      reasons: verdict.reasons,
      requested_home_from: cycle.req_home_from || null,
      requested_return_to_road: cycle.req_return_to_road_date || null,
      approval_status: cycle.linked_request_status || null,
      commitment: commitment.category,
      commitment_reasons: commitment.reasons || [],
      promised_home_from: commitment.promisedHome || null,
      promised_return_to_road: commitment.promisedReturn || null,
      home_delta_days: commitment.homeDeltaDays == null ? null : commitment.homeDeltaDays,
      return_delta_days: commitment.returnDeltaDays == null ? null : commitment.returnDeltaDays,
    };
    d.cycles.push(detail);

    // Company-commitment tally — independent of the driver-policy flow below
    // (which `continue`s past owner operators and incomplete home stays).
    if (commitment.category === COMMITMENT.MET) { company.commitment_met += 1; d.commitment_met += 1; }
    else if (commitment.category === COMMITMENT.BROKEN) { company.commitment_broken += 1; d.commitment_broken += 1; }
    else if (commitment.category === COMMITMENT.INCOMPLETE) { company.commitment_incomplete += 1; d.commitment_incomplete += 1; }
    else if (commitment.category === COMMITMENT.NONE) { company.commitment_none += 1; d.commitment_none += 1; }

    if (verdict.category === CATEGORY.NOT_APPLICABLE) continue;
    if (verdict.category === CATEGORY.INCOMPLETE) {
      d.incomplete += 1;
      continue;
    }
    d.completed_cycles += 1;
    d.road_days_list.push(verdict.roadDays);
    d.home_days_list.push(verdict.homeDays);
    if (verdict.tooShortRoad) d.too_short_road += 1;
    if (verdict.tooLongHome) d.too_long_home += 1;
    if (verdict.category === CATEGORY.COMPLIANT) d.compliant += 1;
    else if (verdict.category === CATEGORY.APPROVED_EXCEPTION) d.approved_exceptions += 1;
    else d.non_compliant += 1;

    const at = cycle.return_to_road_at || cycle.home_arrived_at;
    if (!d.latest_cycle_at || new Date(at) > new Date(d.latest_cycle_at)) {
      d.latest_cycle_at = at;
      d.latest_cycle_result = verdict.category;
    }
  }

  const driverRows = [...drivers.values()].map((d) => {
    const eligible = d.compliant + d.approved_exceptions + d.non_compliant;
    return {
      group_id: d.group_id,
      driver_name: d.driver_name,
      unit_number: d.unit_number,
      driver_type: d.driver_type,
      policy_applies: d.policy_applies,
      current_state: d.current_state,
      completed_cycles: eligible,
      compliant: d.compliant,
      approved_exceptions: d.approved_exceptions,
      non_compliant: d.non_compliant,
      incomplete: d.incomplete,
      too_short_road: d.too_short_road,
      too_long_home: d.too_long_home,
      efficiency_pct: d.policy_applies ? pct(d.compliant, eligible) : null,
      operational_pct: d.policy_applies ? pct(d.compliant + d.approved_exceptions, eligible) : null,
      commitment_met: d.commitment_met,
      commitment_broken: d.commitment_broken,
      commitment_incomplete: d.commitment_incomplete,
      commitment_none: d.commitment_none,
      commitment_pct: d.policy_applies
        ? pct(d.commitment_met, d.commitment_met + d.commitment_broken)
        : null,
      avg_road_days: avg(d.road_days_list),
      avg_home_days: avg(d.home_days_list),
      latest_cycle_result: d.latest_cycle_result,
      latest_cycle_at: d.latest_cycle_at,
      cycles: d.cycles.sort((a, b) => new Date(b.home_arrived_at || 0) - new Date(a.home_arrived_at || 0)),
    };
  }).sort((a, b) => {
    // Owner operators / no-data last; then worst efficiency first.
    const ae = a.efficiency_pct == null ? -1 : a.efficiency_pct;
    const be = b.efficiency_pct == null ? -1 : b.efficiency_pct;
    if (ae !== be) return ae - be;
    return String(a.driver_name).localeCompare(String(b.driver_name));
  });

  const eligibleCompleted = company.compliant + company.approved_exception + company.non_compliant;
  const eligibleDrivers = driverRows.filter((d) => d.policy_applies).length;

  return {
    company: {
      strict_efficiency_pct: pct(company.compliant, eligibleCompleted),
      operational_efficiency_pct: pct(company.compliant + company.approved_exception, eligibleCompleted),
      compliant: company.compliant,
      approved_exception: company.approved_exception,
      non_compliant: company.non_compliant,
      incomplete: company.incomplete,
      not_applicable: company.not_applicable,
      total_eligible_drivers: eligibleDrivers,
      total_completed_cycles: eligibleCompleted,
      commitment_met: company.commitment_met,
      commitment_broken: company.commitment_broken,
      commitment_incomplete: company.commitment_incomplete,
      commitment_none: company.commitment_none,
      commitment_pct: pct(company.commitment_met, company.commitment_met + company.commitment_broken),
      commitment_evaluated: company.commitment_met + company.commitment_broken,
      commitment_grace_days: COMMITMENT_GRACE_DAYS,
      road_allowance_weeks: roadAllowanceWeeks,
      road_allowance_days: roadAllowanceWeeks * DAYS_PER_WEEK,
      home_allowance_days: homeAllowanceDays,
    },
    drivers: driverRows,
  };
}

module.exports = {
  CATEGORY,
  COMMITMENT,
  COMMITMENT_GRACE_DAYS,
  classifyCycle,
  classifyCommitment,
  buildEfficiencyReport,
};
