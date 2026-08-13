/**
 * SOS aggregation — the public /answers summary is ONE company-wide picture and
 * the anonymity boundary:
 *
 *  - percentages are shares of RESPONDENTS by PRIMARY pattern (never a share of
 *    individual answers), the counts add up to the total, and the displayed
 *    percentages add up to 100;
 *  - department and dispatch-team results, group question distributions and any
 *    group ranking are absent from the payload entirely;
 *  - example quotes are authored assessment content, never a submitted answer;
 *  - no per-person field and no scoring key ever leave the server.
 *
 * Uses the real content modules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSummary, primaryPatternShares } = require('../services/sosAssessment/aggregation');
const content = require('../services/sosAssessment/content');
const { PATTERNS } = require('../services/sosAssessment/constants');

/** One respondent. Extra fields are what a careless caller might pass in. */
const sub = (primaryPattern, extra = {}) => ({ primaryPattern, ...extra });

/** Repeats a pattern n times, as n separate respondents. */
const people = (pattern, n) => Array.from({ length: n }, () => sub(pattern));

const row = (summary, pattern) => summary.company.primaryPatterns.find((r) => r.pattern === pattern);

test('percentages are shares of respondents by primary pattern, with the head count', () => {
  // 33 respondents: victim 6, builder 9, ownership 9, waiting 5, blame 2, complaint 2.
  const summary = buildSummary({
    open: true,
    submissions: [
      ...people('victim', 6),
      ...people('builder', 9),
      ...people('ownership', 9),
      ...people('waiting', 5),
      ...people('blame', 2),
      ...people('complaint', 2),
    ],
  });

  assert.equal(summary.total, 33);
  assert.equal(row(summary, 'victim').count, 6);
  assert.equal(row(summary, 'victim').percent, 18, '6 of 33 respondents = 18%');
  assert.equal(row(summary, 'builder').count, 9);
  assert.equal(row(summary, 'builder').percent, 27, '9 of 33 respondents = 27%');
  assert.equal(row(summary, 'ownership').percent, 27);
  assert.equal(row(summary, 'waiting').percent, 15);
  assert.equal(row(summary, 'blame').percent, 6);
  assert.equal(row(summary, 'complaint').percent, 6);
});

test('the percentage is NOT computed from the number of individual answers', () => {
  // One ownership respondent and one victim respondent. Were the headline share
  // taken from answer volume, ten answers per person could shift it; here each
  // person is exactly one unit, so it is a clean 50/50.
  const summary = buildSummary({
    open: true,
    submissions: [sub('ownership'), sub('victim')],
    // Legacy per-answer and per-question inputs must be ignored outright.
    answerPatternRows: [{ submissionDepartment: 'hr', pattern: 'ownership', count: 100 }],
    questionOptionRows: [{ questionKey: 'hr_q01', optionKey: 'hr_q01_b', count: 50 }],
  });
  assert.equal(row(summary, 'ownership').percent, 50);
  assert.equal(row(summary, 'victim').percent, 50);
  assert.ok(!JSON.stringify(summary).includes('100'), 'answer volumes must not reach the payload');
});

test('head counts add up to the total, and each percentage is that count over the total', () => {
  for (const submissions of [
    [...people('victim', 1), ...people('builder', 2)], // thirds — the hard rounding case
    [...people('victim', 1), ...people('complaint', 1), ...people('waiting', 1),
      ...people('blame', 1), ...people('ownership', 1), ...people('builder', 1)],
    people('ownership', 7),
    [...people('victim', 4), ...people('waiting', 4), ...people('builder', 5)],
    [...people('victim', 6), ...people('builder', 9), ...people('ownership', 9),
      ...people('waiting', 5), ...people('blame', 2), ...people('complaint', 2)],
  ]) {
    const summary = buildSummary({ open: true, submissions });
    const rows = summary.company.primaryPatterns;
    assert.equal(rows.length, PATTERNS.length, 'every pattern gets a row, always');
    assert.deepEqual(rows.map((r) => r.pattern), PATTERNS, 'canonical order, not a ranking');
    assert.equal(rows.reduce((sum, r) => sum + r.count, 0), summary.total, 'counts add up exactly');
    for (const r of rows) {
      assert.equal(r.percent, Math.round((r.count * 100) / summary.total),
        `${r.pattern}: each row must be checkable by hand against the head count`);
    }
    // Independent rounding can leave the column a point or two off 100; that is
    // the deliberate trade for every single row being correct on its own.
    const sum = rows.reduce((acc, r) => acc + r.percent, 0);
    assert.ok(Math.abs(sum - 100) <= 2, `percentages sum to ${sum}, expected 100 ± 2`);
  }
});

test('a pattern nobody scored shows 0% and 0 people — never rounded up', () => {
  const summary = buildSummary({
    open: true,
    submissions: [...people('victim', 1), ...people('builder', 1), ...people('ownership', 1)],
  });
  for (const pattern of ['complaint', 'waiting', 'blame']) {
    assert.equal(row(summary, pattern).count, 0, pattern);
    assert.equal(row(summary, pattern).percent, 0, `${pattern} must stay at 0%`);
  }
  assert.equal(row(summary, 'victim').percent, 33);
});

test('a single respondent reads as 100% of one pattern', () => {
  const summary = buildSummary({ open: true, submissions: [sub('ownership')] });
  assert.equal(summary.total, 1);
  assert.equal(row(summary, 'ownership').count, 1);
  assert.equal(row(summary, 'ownership').percent, 100);
  assert.deepEqual(summary.company.topPatterns, ['ownership']);
});

test('the zero-response summary is well-formed for the projector empty state', () => {
  const summary = buildSummary({ open: false, submissions: [] });
  assert.equal(summary.open, false);
  assert.equal(summary.total, 0);
  assert.equal(summary.company.topPatterns.length, 0);
  assert.equal(summary.company.primaryPatterns.length, PATTERNS.length);
  assert.ok(summary.company.primaryPatterns.every((r) => r.count === 0 && r.percent === 0),
    'no division-by-zero artefacts and no NaN');
  assert.ok(!JSON.stringify(summary).includes('NaN'));
  assert.ok(summary.presentation.centralQuestion.length > 10);
  assert.ok(summary.patternMeta.ownership.name.length > 2);
});

test('buildSummary with no submissions argument at all still returns the empty shape', () => {
  const summary = buildSummary({ open: true });
  assert.equal(summary.total, 0);
  assert.equal(summary.company.primaryPatterns.length, PATTERNS.length);
});

test('an unknown primary pattern is counted in the total but never invented as a row', () => {
  const summary = buildSummary({ open: true, submissions: [sub('ownership'), sub('mystery')] });
  assert.equal(summary.total, 2, 'the respondent is still one of us');
  assert.equal(summary.company.primaryPatterns.length, PATTERNS.length);
  assert.ok(!JSON.stringify(summary.company).includes('mystery'));
});

// ─────────────── what the public payload must NOT contain ───────────────

test('no department, dispatch-team or question-distribution data is served publicly', () => {
  const summary = buildSummary({
    open: true,
    submissions: [
      sub('ownership', { department: 'hr' }),
      sub('builder', { department: 'dispatch', dispatchTeamName: 'Anthony / Allen / Scott', dispatchTeamId: 1 }),
      sub('victim', { department: 'trailer' }),
    ],
  });

  assert.deepEqual(Object.keys(summary).sort(), ['company', 'open', 'patternMeta', 'presentation', 'total']);
  assert.deepEqual(Object.keys(summary.company).sort(), ['primaryPatterns', 'topPatterns']);
  for (const r of summary.company.primaryPatterns) {
    assert.deepEqual(Object.keys(r).sort(), ['count', 'pattern', 'percent']);
  }

  const json = JSON.stringify(summary);
  for (const forbidden of [
    'departments', 'department', 'labelUz', 'dispatchTeam', 'teamName',
    'Anthony / Allen / Scott', 'questions', 'questionKey', 'optionKey',
    'answerPatternCounts', 'primaryCounts', 'trailer', 'hr',
  ]) {
    assert.ok(!json.includes(forbidden), `${forbidden} must not appear in a public summary`);
  }
  assert.ok(!/\bboʻlim(lar)? kesim/i.test(json), 'no department-comparison copy may be served');
});

test('the public summary never contains per-person data or the scoring key', () => {
  const summary = buildSummary({
    open: true,
    submissions: [
      sub('ownership', { fullName: 'SHOULD-NEVER-LEAK', resultToken: 'tok-123', clientIp: '1.2.3.4', id: 777 }),
      sub('builder'),
    ],
  });
  const json = JSON.stringify(summary);
  for (const forbidden of ['SHOULD-NEVER-LEAK', 'tok-123', '1.2.3.4', '777', 'fullName', 'resultToken', 'clientIp']) {
    assert.ok(!json.includes(forbidden), `${forbidden} leaked`);
  }
  assert.ok(!json.includes('"weight"'), 'no answer weights');
  // No option key anywhere means the option→pattern mapping cannot be rebuilt.
  for (const dept of ['hr', 'safety', 'dispatch', 'trailer', 'samsara', 'accounting', 'updaters']) {
    for (const q of content.getQuestions(dept)) {
      assert.ok(!json.includes(q.key), `${q.key} leaked`);
      for (const o of q.options) assert.ok(!json.includes(o.key), `${o.key} leaked`);
    }
  }
});

// ─────────────── representative examples ───────────────

test('each pattern carries an authored example quote from the assessment content', () => {
  const summary = buildSummary({ open: true, submissions: people('ownership', 3) });
  for (const pattern of PATTERNS) {
    const meta = summary.patternMeta[pattern];
    const authored = content.getPatternResult(pattern).exampleThought.uz;
    assert.equal(meta.example, authored, `${pattern}: the example must come from content/results`);
    assert.ok(meta.example.trim().length > 5 && meta.example.trim().length <= 120,
      `${pattern}: the example must be one projector-readable line`);
  }
});

test('the example is identical for every dataset, so it can never be someone\'s answer', () => {
  const a = buildSummary({ open: true, submissions: people('victim', 4) });
  const b = buildSummary({ open: true, submissions: people('builder', 11) });
  const c = buildSummary({ open: false, submissions: [] });
  for (const pattern of PATTERNS) {
    assert.equal(a.patternMeta[pattern].example, b.patternMeta[pattern].example, pattern);
    assert.equal(a.patternMeta[pattern].example, c.patternMeta[pattern].example, pattern);
  }
});

test('an example quote is never one of the questionnaire option texts', () => {
  // Quoting a real option would publish part of the scoring key while the
  // questionnaire is still open, on top of looking like a submitted answer.
  const optionTexts = new Set();
  for (const dept of ['hr', 'safety', 'dispatch', 'trailer', 'samsara', 'accounting', 'updaters']) {
    for (const q of content.getQuestions(dept)) {
      for (const o of q.options) for (const lang of ['uz', 'ru', 'en']) optionTexts.add(o.text[lang].trim());
    }
  }
  for (const pattern of PATTERNS) {
    const block = content.getPatternResult(pattern);
    for (const lang of ['uz', 'ru', 'en']) {
      assert.ok(!optionTexts.has(block.exampleThought[lang].trim()),
        `${pattern} ${lang}: the example must be authored, not a questionnaire option`);
    }
  }
});

// ─────────────── the share helper on its own ───────────────

test('primaryPatternShares is deterministic and total-safe', () => {
  const counts = { victim: 1, complaint: 1, waiting: 1, blame: 1, ownership: 1, builder: 1 };
  const first = primaryPatternShares(counts, 6);
  const second = primaryPatternShares(counts, 6);
  assert.deepEqual(first, second, 'the same input always yields the same percentages');
  assert.ok(first.every((r) => r.percent === 17), 'one sixth rounds to 17% on every row');
  assert.ok(primaryPatternShares(counts, 0).every((r) => r.percent === 0), 'no total means no percentages');
  assert.ok(primaryPatternShares({}, 5).every((r) => r.count === 0 && r.percent === 0),
    'missing counts degrade to zero, never NaN');
});
