/**
 * SOS aggregation — anonymity boundary for the public /answers summary:
 * k=3 suppression for small groups, no per-person data, no scoring key on
 * question distributions. Uses the real content modules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSummary, MIN_GROUP } = require('../services/sosAssessment/aggregation');

const sub = (department, primaryPattern, teamName = null, teamId = null) => ({
  department,
  dispatchTeamId: teamId,
  dispatchTeamName: teamName,
  primaryPattern,
});

test('company and department distributions render once the group reaches the threshold', () => {
  const submissions = [
    sub('hr', 'ownership'), sub('hr', 'waiting'), sub('hr', 'ownership'),
    sub('dispatch', 'builder', 'Team Alpha', 1),
  ];
  const summary = buildSummary({
    open: true,
    submissions,
    answerPatternRows: [
      { submissionDepartment: 'hr', pattern: 'ownership', count: 12 },
      { submissionDepartment: 'hr', pattern: 'waiting', count: 9 },
    ],
    questionOptionRows: [{ questionKey: 'hr_q01', optionKey: 'hr_q01_b', count: 2 }],
  });

  assert.equal(summary.total, 4);
  assert.equal(summary.company.suppressed, false);
  assert.equal(summary.company.primaryCounts.ownership, 2);
  assert.equal(summary.company.answerPatternCounts.ownership, 12);
  assert.deepEqual(summary.company.topPatterns.slice(0, 1), ['ownership']);

  const hr = summary.departments.find((d) => d.key === 'hr');
  assert.equal(hr.suppressed, false);
  assert.equal(hr.count, 3);
  assert.equal(hr.primaryCounts.ownership, 2);
  assert.ok(Array.isArray(hr.questions) && hr.questions.length === 10);
  const q1 = hr.questions.find((q) => q.key === 'hr_q01');
  assert.equal(q1.options.find((o) => o.key === 'hr_q01_b').count, 2);
});

test('groups below the threshold expose only their participant count', () => {
  const submissions = [
    sub('hr', 'ownership'), sub('hr', 'waiting'), sub('hr', 'ownership'),
    sub('accounting', 'victim'), // 1 person — must be suppressed
    sub('dispatch', 'blame', 'Team Alpha', 1), sub('dispatch', 'builder', 'Team Alpha', 1),
  ];
  const summary = buildSummary({ open: true, submissions });

  const accounting = summary.departments.find((d) => d.key === 'accounting');
  assert.equal(accounting.suppressed, true);
  assert.equal(accounting.count, 1);
  assert.equal(accounting.primaryCounts, undefined);
  assert.equal(accounting.questions, undefined);
  assert.equal(accounting.topPatterns, undefined);

  // Dispatch dept has 2 (< 3) — suppressed; its team likewise.
  const dispatch = summary.departments.find((d) => d.key === 'dispatch');
  assert.equal(dispatch.suppressed, true);
  const team = summary.dispatchTeams.find((t) => t.teamName === 'Team Alpha');
  assert.equal(team.suppressed, true);
  assert.equal(team.count, 2);
  assert.equal(team.primaryCounts, undefined);
});

test('the whole company is suppressed below the threshold', () => {
  const summary = buildSummary({ open: true, submissions: [sub('hr', 'victim'), sub('safety', 'blame')] });
  assert.equal(summary.total, 2);
  assert.equal(summary.company.suppressed, true);
  assert.equal(summary.company.primaryCounts, undefined);
  assert.equal(MIN_GROUP, 3);
});

test('dispatch team distributions render at the threshold', () => {
  const submissions = [
    sub('dispatch', 'ownership', 'Team Alpha', 1),
    sub('dispatch', 'ownership', 'Team Alpha', 1),
    sub('dispatch', 'waiting', 'Team Alpha', 1),
    sub('dispatch', 'builder', 'Team Beta', 2),
  ];
  const summary = buildSummary({ open: true, submissions });
  const alpha = summary.dispatchTeams.find((t) => t.teamName === 'Team Alpha');
  assert.equal(alpha.suppressed, false);
  assert.equal(alpha.primaryCounts.ownership, 2);
  assert.deepEqual(alpha.topPatterns[0], 'ownership');
  const beta = summary.dispatchTeams.find((t) => t.teamName === 'Team Beta');
  assert.equal(beta.suppressed, true);
});

test('the public summary never contains per-person or scoring-key data', () => {
  const submissions = [
    { ...sub('hr', 'ownership'), fullName: 'SHOULD-NEVER-LEAK', resultToken: 'tok-123', clientIp: '1.2.3.4' },
    sub('hr', 'waiting'), sub('hr', 'blame'),
    sub('dispatch', 'builder', 'Team Alpha', 1), sub('dispatch', 'victim', 'Team Alpha', 1),
    sub('dispatch', 'complaint', 'Team Alpha', 1),
  ];
  const summary = buildSummary({
    open: true,
    submissions,
    questionOptionRows: [{ questionKey: 'hr_q02', optionKey: 'hr_q02_d', count: 3 }],
  });
  const json = JSON.stringify(summary);
  assert.ok(!json.includes('SHOULD-NEVER-LEAK'), 'name leaked');
  assert.ok(!json.includes('tok-123'), 'token leaked');
  assert.ok(!json.includes('1.2.3.4'), 'ip leaked');
  assert.ok(!json.includes('fullName'), 'fullName field leaked');
  assert.ok(!json.includes('resultToken'), 'resultToken field leaked');

  // Question distributions must not carry the option→pattern mapping.
  for (const dept of summary.departments) {
    for (const q of dept.questions || []) {
      for (const opt of q.options) {
        assert.deepEqual(Object.keys(opt).sort(), ['count', 'key', 'textUz']);
      }
    }
  }
});

test('closed state and empty state are represented', () => {
  const closed = buildSummary({ open: false, submissions: [] });
  assert.equal(closed.open, false);
  assert.equal(closed.total, 0);
  assert.equal(closed.company.suppressed, true);
  assert.ok(closed.presentation.centralQuestion.length > 10);
  assert.ok(closed.patternMeta.ownership.name.length > 2);
});
