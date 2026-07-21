const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCycle, classifyCommitment, buildEfficiencyReport, CATEGORY, COMMITMENT,
} = require('../services/homeTimeEfficiencyService');

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

// ── Company commitment (registered/approved dates vs. what actually happened) ──

// A cycle linked to an APPROVED request whose promised dates match reality.
function committedCycle(over = {}) {
  return cycle({
    linked_request_status: 'approved',
    req_home_from: '2026-02-01', req_return_to_road_date: '2026-02-05',
    home_arrived_at: '2026-02-01T12:00:00Z', return_to_road_at: '2026-02-05T09:00:00Z',
    ...over,
  });
}

test('commitment met: driver got home and returned on the promised dates', () => {
  const v = classifyCommitment(committedCycle());
  assert.equal(v.category, COMMITMENT.MET);
  assert.equal(v.promisedHome, '2026-02-01');
  assert.equal(v.promisedReturn, '2026-02-05');
});

test('commitment broken: driver got home LATE relative to the approved date', () => {
  const v = classifyCommitment(committedCycle({ home_arrived_at: '2026-02-05T00:00:00Z' })); // 4 days late
  assert.equal(v.category, COMMITMENT.BROKEN);
  assert.ok(v.reasons.includes('home_late'));
});

test('commitment broken: driver returned to the road LATE relative to the approved date', () => {
  const v = classifyCommitment(committedCycle({ return_to_road_at: '2026-02-10T00:00:00Z' })); // 5 days late
  assert.equal(v.category, COMMITMENT.BROKEN);
  assert.ok(v.reasons.includes('returned_late'));
});

test('commitment tolerates a one-day grace on both ends', () => {
  const v = classifyCommitment(committedCycle({
    home_arrived_at: '2026-02-02T00:00:00Z', return_to_road_at: '2026-02-06T00:00:00Z',
  }));
  assert.equal(v.category, COMMITMENT.MET);
});

test('commitment none: no approved registered dates → nothing to measure', () => {
  assert.equal(classifyCommitment(cycle({ linked_request_status: null })).category, COMMITMENT.NONE);
  assert.equal(classifyCommitment(cycle({ linked_request_status: 'pending', req_home_from: '2026-02-01' })).category, COMMITMENT.NONE);
});

test('commitment incomplete: approved window but the home stay is still open', () => {
  const v = classifyCommitment(committedCycle({ return_to_road_at: null }));
  assert.equal(v.category, COMMITMENT.INCOMPLETE);
});

test('commitment falls back to home_to + 1 when the approved return date is absent', () => {
  const v = classifyCommitment(committedCycle({ req_return_to_road_date: null, req_home_to: '2026-02-04' }));
  assert.equal(v.promisedReturn, '2026-02-05');
  assert.equal(v.category, COMMITMENT.MET);
});

test('owner operators are not applicable for commitment', () => {
  const v = classifyCommitment(committedCycle({ driver_type: 'owner', group_name: 'U OWNER OPERATOR' }));
  assert.equal(v.category, COMMITMENT.NOT_APPLICABLE);
});

test('company commitment % = met ÷ (met + broken); no-data & incomplete excluded', () => {
  const cycles = [
    committedCycle({ id: 1, group_id: 1 }), // met
    committedCycle({ id: 2, group_id: 1, home_arrived_at: '2026-02-06T00:00:00Z' }), // broken (home late)
    committedCycle({ id: 3, group_id: 2, return_to_road_at: null, group_name: 'U2 COMPANY DRIVER' }), // incomplete
    cycle({ id: 4, group_id: 3, linked_request_status: null, group_name: 'U3 COMPANY DRIVER' }), // no commitment
  ];
  const rep = buildEfficiencyReport({ cycles, statuses: [], settings: { road_allowance_weeks: 4, home_allowance_days: 4 } });
  assert.equal(rep.company.commitment_met, 1);
  assert.equal(rep.company.commitment_broken, 1);
  assert.equal(rep.company.commitment_incomplete, 1);
  assert.equal(rep.company.commitment_none, 1);
  assert.equal(rep.company.commitment_evaluated, 2);
  assert.equal(rep.company.commitment_pct, 50);
  const d1 = rep.drivers.find((d) => d.group_id === 1);
  assert.equal(d1.commitment_pct, 50);
});
