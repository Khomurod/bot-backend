/**
 * SOS aggregation — anonymity boundary for the public /answers summaries:
 * no per-person data and no scoring key ever leave the server, while
 * department and dispatch-team results render for ANY group size (the
 * previous minimum-three-person suppression is intentionally removed).
 * Uses the real content modules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSummary } = require('../services/sosAssessment/aggregation');

const sub = (department, primaryPattern, teamName = null, teamId = null) => ({
  department,
  dispatchTeamId: teamId,
  dispatchTeamName: teamName,
  primaryPattern,
});

test('a company summary works with exactly ONE response', () => {
  const summary = buildSummary({
    open: true,
    submissions: [sub('hr', 'ownership')],
    answerPatternRows: [{ submissionDepartment: 'hr', pattern: 'ownership', count: 10 }],
    questionOptionRows: [{ questionKey: 'hr_q01', optionKey: 'hr_q01_b', count: 1 }],
  });
  assert.equal(summary.total, 1);
  assert.equal(summary.company.primaryCounts.ownership, 1);
  assert.equal(summary.company.answerPatternCounts.ownership, 10);
  assert.deepEqual(summary.company.topPatterns, ['ownership']);

  const hr = summary.departments.find((d) => d.key === 'hr');
  assert.equal(hr.count, 1);
  assert.equal(hr.primaryCounts.ownership, 1, 'one-person department shows its distribution');
  assert.ok(Array.isArray(hr.questions) && hr.questions.length === 10, 'question distributions render with one response');
  assert.equal(hr.questions.find((q) => q.key === 'hr_q01').options.find((o) => o.key === 'hr_q01_b').count, 1);
});

test('a department summary works with TWO responses', () => {
  const summary = buildSummary({
    open: true,
    submissions: [sub('accounting', 'waiting'), sub('accounting', 'builder')],
  });
  const accounting = summary.departments.find((d) => d.key === 'accounting');
  assert.equal(accounting.count, 2);
  assert.equal(accounting.primaryCounts.waiting, 1);
  assert.equal(accounting.primaryCounts.builder, 1);
  assert.ok(accounting.topPatterns.length >= 1);
  assert.ok(accounting.technique.length > 20, 'technique renders for a two-person department');
});

test('dispatch-team summaries work with ONE and TWO responses', () => {
  const summary = buildSummary({
    open: true,
    submissions: [
      sub('dispatch', 'ownership', 'Team Alpha', 1),
      sub('dispatch', 'waiting', 'Team Alpha', 1),
      sub('dispatch', 'builder', 'Team Beta', 2),
    ],
  });
  const alpha = summary.dispatchTeams.find((t) => t.teamName === 'Team Alpha');
  assert.equal(alpha.count, 2);
  assert.equal(alpha.primaryCounts.ownership, 1);
  assert.equal(alpha.primaryCounts.waiting, 1);
  const beta = summary.dispatchTeams.find((t) => t.teamName === 'Team Beta');
  assert.equal(beta.count, 1, 'a one-person team is shown');
  assert.equal(beta.primaryCounts.builder, 1, 'with its distribution');
  assert.deepEqual(beta.topPatterns, ['builder']);
});

test('no suppressed state and no minimum-group machinery exists anywhere in the payload', () => {
  const summary = buildSummary({
    open: true,
    submissions: [sub('hr', 'victim'), sub('safety', 'blame'), sub('dispatch', 'complaint', 'Team Alpha', 1)],
  });
  const json = JSON.stringify(summary);
  assert.ok(!json.includes('suppressed'), 'no suppressed flag may appear');
  assert.ok(!json.includes('minGroup'), 'no minimum-group field may appear');
  assert.ok(!/kamida 3|3 kishidan/i.test(json), 'no minimum-group privacy message may appear');
});

test('zero-response groups keep the normal empty state (count 0, no distributions block)', () => {
  const summary = buildSummary({ open: true, submissions: [sub('hr', 'ownership')] });
  const trailer = summary.departments.find((d) => d.key === 'trailer');
  assert.equal(trailer.count, 0);
  assert.equal(trailer.questions, undefined, 'question blocks only render once a department has data');
  assert.equal(summary.dispatchTeams.length, 0, 'teams appear only once someone from that team responds');
});

test('the empty summary (zero total) is well-formed for the projector empty state', () => {
  const summary = buildSummary({ open: false, submissions: [] });
  assert.equal(summary.open, false);
  assert.equal(summary.total, 0);
  assert.equal(summary.company.topPatterns.length, 0);
  assert.ok(summary.presentation.centralQuestion.length > 10);
  assert.ok(summary.patternMeta.ownership.name.length > 2);
});

test('the public summary never contains per-person or scoring-key data', () => {
  const submissions = [
    { ...sub('hr', 'ownership'), fullName: 'SHOULD-NEVER-LEAK', resultToken: 'tok-123', clientIp: '1.2.3.4', id: 777 },
    sub('dispatch', 'builder', 'Team Alpha', 1),
  ];
  const summary = buildSummary({
    open: true,
    submissions,
    questionOptionRows: [{ questionKey: 'hr_q02', optionKey: 'hr_q02_d', count: 1 }],
  });
  const json = JSON.stringify(summary);
  assert.ok(!json.includes('SHOULD-NEVER-LEAK'), 'name leaked');
  assert.ok(!json.includes('tok-123'), 'token leaked');
  assert.ok(!json.includes('1.2.3.4'), 'ip leaked');
  assert.ok(!json.includes('777'), 'submission id leaked');
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
