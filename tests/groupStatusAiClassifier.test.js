const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseClassificationResponse,
  classifyGroupHeuristic,
  extractJsonArray,
} = require('../services/groupStatusAiClassifier');

const INACTIVE_TITLE =
  'WENZE UNIT # 07 DAMARIUS JOHNSON ( COMPANY ) INACTIVE';

test('extractJsonArray parses fenced JSON array', () => {
  const text = 'Here is the result:\n```json\n[{"id":1,"active":false}]\n```';
  const arr = extractJsonArray(text);
  assert.deepEqual(arr, [{ id: 1, active: false }]);
});

test('parseClassificationResponse maps ids and ignores hallucinated ids', () => {
  const batch = [
    { id: 10, group_name: INACTIVE_TITLE },
    { id: 11, group_name: 'ACTIVE UNIT # 01 JOHN DOE' },
  ];
  const raw = JSON.stringify([
    { id: 10, active: false, reason: 'INACTIVE in title' },
    { id: 99, active: true, reason: 'bogus' },
    { id: 11, active: true, reason: 'no inactive marker' },
  ]);
  const results = parseClassificationResponse(raw, batch);
  assert.equal(results.length, 2);
  assert.deepEqual(results.find((r) => r.id === 10), {
    id: 10,
    active: false,
    reason: 'INACTIVE in title',
  });
  assert.equal(results.find((r) => r.id === 11).active, true);
});

test('classifyGroupHeuristic marks INACTIVE titles inactive', () => {
  const result = classifyGroupHeuristic({ id: 5, group_name: INACTIVE_TITLE });
  assert.equal(result.active, false);
  assert.equal(result.reason, 'heuristic');
});

test('classifyGroupHeuristic says NOTHING about a title with no status marker', () => {
  // This used to assert `true`, and that was the bug facing the other way. A
  // title that does not say INACTIVE is the ABSENCE of evidence, not evidence
  // that somebody still works here — and returning `true` for it let a scan
  // that found nothing at all flip a driver an operator had marked inactive
  // back to active. `null` means no change; a real disagreement between
  // `groups.active` and `driver_profiles.status` is already a Stage 2 finding
  // for a human, which is where a decision like that belongs.
  const result = classifyGroupHeuristic({
    id: 6,
    group_name: 'WENZE UNIT # 01 JANE DOE ( COMPANY DRIVER )',
  });
  assert.equal(result.active, null);
});

test('upsertGroup ON CONFLICT does not force active = TRUE', () => {
  const dbSrc = fs.readFileSync(
    path.join(__dirname, '../database/groups.js'),
    'utf8'
  );
  const upsertMatch = dbSrc.match(
    /async function upsertGroup[\s\S]*?DO UPDATE SET([^`]+)/
  );
  assert.ok(upsertMatch, 'upsertGroup should exist');
  const updateClause = upsertMatch[1];
  assert.match(updateClause, /group_name\s*=\s*EXCLUDED\.group_name/);
  assert.doesNotMatch(updateClause, /active\s*=\s*TRUE/i);
});
