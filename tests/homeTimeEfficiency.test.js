const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCycle, buildEfficiencyReport, CATEGORY } = require('../services/homeTimeEfficiencyService');

const OPTS = { roadAllowanceWeeks: 4, homeAllowanceDays: 4 }; // 28 road days / 4 home days

function cycle(over = {}) {
  return {
    id: 1, group_id: 1, driver_type: 'company_driver', group_name: 'WENZE UNIT # 1 COMPANY DRIVER',
    days_on_road: 30, home_days: 4, return_to_road_at: '2026-02-05T00:00:00Z',
    home_arrived_at: '2026-02-01T00:00:00Z', road_started_at: '2026-01-02T00:00:00Z', ...over,
  };
}

test('policy-compliant cycle (road≥28, home≤4) is compliant', () => {
  assert.equal(classifyCycle(cycle({ days_on_road: 30, home_days: 4 }), OPTS).category, CATEGORY.COMPLIANT);
});

test('too-short-road cycle is non_compliant with too_short_road reason', () => {
  const v = classifyCycle(cycle({ days_on_road: 20, home_days: 3 }), OPTS);
  assert.equal(v.category, CATEGORY.NON_COMPLIANT);
  assert.ok(v.reasons.includes('too_short_road'));
});

test('too-long-home cycle is non_compliant with too_long_home reason', () => {
  const v = classifyCycle(cycle({ days_on_road: 30, home_days: 7 }), OPTS);
  assert.equal(v.category, CATEGORY.NON_COMPLIANT);
  assert.ok(v.reasons.includes('too_long_home'));
});

test('approved exception is separate from ordinary non-compliance', () => {
  const v = classifyCycle(cycle({ days_on_road: 30, home_days: 7, linked_request_status: 'approved' }), OPTS);
  assert.equal(v.category, CATEGORY.APPROVED_EXCEPTION);
});

test('incomplete data (home stay not closed) is excluded, not counted as a violation', () => {
  const v = classifyCycle(cycle({ return_to_road_at: null, home_days: null }), OPTS);
  assert.equal(v.category, CATEGORY.INCOMPLETE);
});

test('owner operators are not applicable', () => {
  const v = classifyCycle(cycle({ driver_type: 'owner' }), OPTS);
  assert.equal(v.category, CATEGORY.NOT_APPLICABLE);
});

test('company efficiency = compliant ÷ eligible; operational credits approved exceptions', () => {
  const cycles = [
    cycle({ id: 1, group_id: 1, days_on_road: 30, home_days: 4 }), // compliant
    cycle({ id: 2, group_id: 1, days_on_road: 20, home_days: 3 }), // non-compliant
    cycle({ id: 3, group_id: 2, days_on_road: 30, home_days: 8, linked_request_status: 'approved', group_name: 'U2 COMPANY DRIVER' }), // approved exception
    cycle({ id: 4, group_id: 3, driver_type: 'owner', group_name: 'U3 OWNER OPERATOR' }), // N/A
    cycle({ id: 5, group_id: 1, return_to_road_at: null, home_days: null }), // incomplete
  ];
  const rep = buildEfficiencyReport({ cycles, statuses: [], settings: { road_allowance_weeks: 4, home_allowance_days: 4 } });
  // eligible completed = compliant(1) + approved_exception(1) + non_compliant(1) = 3
  assert.equal(rep.company.total_completed_cycles, 3);
  assert.equal(rep.company.compliant, 1);
  assert.equal(rep.company.approved_exception, 1);
  assert.equal(rep.company.non_compliant, 1);
  assert.equal(rep.company.incomplete, 1);
  assert.equal(rep.company.not_applicable, 1);
  assert.equal(rep.company.strict_efficiency_pct, Math.round((1 / 3) * 1000) / 10); // 33.3
  assert.equal(rep.company.operational_efficiency_pct, Math.round((2 / 3) * 1000) / 10); // 66.7
  assert.equal(rep.company.total_eligible_drivers, 2); // groups 1 & 2 (company); owner excluded
});

test('per-driver efficiency is computed and owner operators show N/A', () => {
  const cycles = [
    cycle({ id: 1, group_id: 1, days_on_road: 30, home_days: 4 }),
    cycle({ id: 2, group_id: 1, days_on_road: 30, home_days: 4 }),
    cycle({ id: 3, group_id: 1, days_on_road: 20, home_days: 3 }), // one violation
    cycle({ id: 9, group_id: 5, driver_type: 'owner', group_name: 'U5 OWNER OPERATOR' }),
  ];
  const rep = buildEfficiencyReport({ cycles, statuses: [], settings: { road_allowance_weeks: 4, home_allowance_days: 4 } });
  const d1 = rep.drivers.find((d) => d.group_id === 1);
  assert.equal(d1.completed_cycles, 3);
  assert.equal(d1.compliant, 2);
  assert.equal(d1.non_compliant, 1);
  assert.equal(d1.efficiency_pct, Math.round((2 / 3) * 1000) / 10); // 66.7
  assert.equal(d1.avg_road_days, Math.round(((30 + 30 + 20) / 3) * 10) / 10);
  const owner = rep.drivers.find((d) => d.group_id === 5);
  assert.equal(owner.policy_applies, false);
  assert.equal(owner.efficiency_pct, null);
});

test('no eligible cycles → efficiency is null (no misleading number)', () => {
  const rep = buildEfficiencyReport({
    cycles: [cycle({ id: 1, group_id: 1, return_to_road_at: null, home_days: null })],
    statuses: [], settings: { road_allowance_weeks: 4, home_allowance_days: 4 },
  });
  assert.equal(rep.company.total_completed_cycles, 0);
  assert.equal(rep.company.strict_efficiency_pct, null);
});
