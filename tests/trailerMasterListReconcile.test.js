/**
 * Unit tests for the master-list normalization and reconciliation engines.
 *
 * Both are pure, so every rule the spec cares about is testable without a
 * database: normalization, confusable folding, cross-image deduplication,
 * conflict detection, and the four reconciliation groups.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeUnitNumber, confusableSkeleton, isConfusablePair, similarity, suggestSimilar,
} = require('../services/trailerMasterList/normalize');
const {
  deduplicateRows, detectSnapshotConflicts, diffMatched, reconcileSnapshot,
} = require('../services/trailerMasterList/reconcile');

// ─── normalization ───

test('unit numbers normalize to the historical storage form', () => {
  assert.equal(normalizeUnitNumber('  #t-100 '), 'T-100');
  assert.equal(normalizeUnitNumber('t 1 0 0'), 'T100');
  assert.equal(normalizeUnitNumber('T-100'), 'T-100');
});

test('blank unit numbers normalize to null', () => {
  for (const blank of [null, undefined, '', '   ', '#', ' # ']) {
    assert.equal(normalizeUnitNumber(blank), null, `${JSON.stringify(blank)} is blank`);
  }
});

test('confusable characters fold to a shared skeleton', () => {
  assert.equal(confusableSkeleton('T-1OO'), confusableSkeleton('T-100'));
  assert.equal(confusableSkeleton('5B'), confusableSkeleton('58'));
  assert.equal(confusableSkeleton('IB'), '18');
});

test('confusable pairs are detected but identical numbers are not', () => {
  assert.equal(isConfusablePair('T-1OO', 'T-100'), true, '0/O');
  assert.equal(isConfusablePair('TI00', 'T100'), true, '1/I');
  assert.equal(isConfusablePair('T-5', 'T-S'), true, '5/S');
  assert.equal(isConfusablePair('T-8', 'T-B'), true, '8/B');
  assert.equal(isConfusablePair('T-100', 'T-100'), false, 'identical is not a conflict');
  assert.equal(isConfusablePair('T-100', 'T-200'), false, 'genuinely different');
});

test('similarity ranks a confusable twin above an unrelated unit', () => {
  assert.equal(similarity('T-100', 'T-1OO'), 1, 'confusable twin is indistinguishable');
  assert.ok(similarity('T-100', 'T-101') > similarity('T-100', 'X-999'));
});

test('suggestions are ranked, thresholded and capped', () => {
  const candidates = [
    { id: 1, unit_number: 'T-100' },
    { id: 2, unit_number: 'T-101' },
    { id: 3, unit_number: 'ZZ-8888' },
  ];
  const suggestions = suggestSimilar('T-1OO', candidates, { limit: 2 });
  assert.equal(suggestions[0].id, 1);
  assert.equal(suggestions[0].confusable, true);
  assert.ok(suggestions.length <= 2);
  assert.ok(!suggestions.some((s) => s.unit_number === 'ZZ-8888'), 'unrelated units fall below threshold');
});

// ─── deduplication across overlapping photos ───

test('a trailer repeated across overlapping photos collapses to one row', () => {
  const { rows, duplicateGroups } = deduplicateRows([
    { unit_number: 'T-100', vin: '1ABC', source_image_index: 0 },
    { unit_number: ' #t-100 ', vin: '1ABC', source_image_index: 1 },
  ]);
  assert.equal(rows.length, 1, 'overlap is expected, not an error');
  assert.equal(duplicateGroups[0].occurrences, 2);
  assert.deepEqual(duplicateGroups[0].images, [0, 1]);
  assert.deepEqual(duplicateGroups[0].conflicts, {}, 'agreeing repeats are not conflicts');
});

test('a dash difference is a different unit and is escalated, never merged', () => {
  // normalizeUnitNumber strips '#' and whitespace but NOT separators, because
  // every production unit_number is already stored that way. So T-100 and T100
  // are distinct identities: deduplication must keep them apart, and the
  // confusable check must surface the pair for a human instead of guessing.
  const { rows } = deduplicateRows([{ unit_number: 'T-100' }, { unit_number: 'T100' }]);
  assert.equal(rows.length, 2, 'distinct identities are never silently merged');

  const conflicts = detectSnapshotConflicts(rows);
  assert.ok(
    conflicts.some((c) => c.type === 'confusable_unit_numbers'),
    'the near-identical pair is escalated for review',
  );
});

test('a blank field in one photo is filled from another', () => {
  const { rows } = deduplicateRows([
    { unit_number: 'T-100', vin: '1ABC', plate_number: null },
    { unit_number: 'T-100', vin: null, plate_number: 'XYZ-9' },
  ]);
  assert.equal(rows[0].vin, '1ABC');
  assert.equal(rows[0].plate_number, 'XYZ-9');
});

test('photos disagreeing on a value raise a field conflict', () => {
  const { rows } = deduplicateRows([
    { unit_number: 'T-100', vin: '1ABC' },
    { unit_number: 'T-100', vin: '2XYZ' },
  ]);
  assert.deepEqual(rows[0].field_conflicts.vin, ['1ABC', '2XYZ']);
});

test('rows without a unit number are dropped rather than invented', () => {
  const { rows } = deduplicateRows([
    { unit_number: null, vin: '1ABC' },
    { unit_number: '   ', vin: '2XYZ' },
    { unit_number: 'T-1', vin: '3DEF' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unit_number, 'T-1');
});

// ─── conflict detection ───

test('one VIN across several unit numbers is a conflict', () => {
  const conflicts = detectSnapshotConflicts([
    { unit_number: 'T-100', vin: '1ABC' },
    { unit_number: 'T-200', vin: '1ABC' },
  ]);
  const conflict = conflicts.find((c) => c.type === 'vin_shared_by_multiple_units');
  assert.ok(conflict);
  assert.deepEqual(conflict.unit_numbers.sort(), ['T-100', 'T-200']);
});

test('confusable unit numbers inside one snapshot are a conflict', () => {
  const conflicts = detectSnapshotConflicts([
    { unit_number: 'T-100' },
    { unit_number: 'T-1OO' },
  ]);
  assert.ok(conflicts.some((c) => c.type === 'confusable_unit_numbers'));
});

// ─── matched diffing ───

test('a blank extracted field never overwrites an existing value', () => {
  const changes = diffMatched(
    { unit_number: 'T-100', vin: '1ABC', plate_number: 'OLD-1' },
    { unit_number: 'T-100', vin: null, plate_number: '' },
  );
  assert.deepEqual(changes, [], 'the AI failing to read a column is not evidence the data is gone');
});

test('identity-critical changes are flagged for explicit confirmation', () => {
  const changes = diffMatched(
    { unit_number: 'T-100', vin: '1ABC', make: 'Utility' },
    { unit_number: 'T-100', vin: '2XYZ', make: 'Wabash' },
  );
  const vin = changes.find((c) => c.field === 'vin');
  const make = changes.find((c) => c.field === 'make');
  assert.equal(vin.identity_critical, true);
  assert.equal(make.identity_critical, false);
  assert.equal(vin.from, '1ABC');
  assert.equal(vin.to, '2XYZ');
});

test('an unchanged field produces no diff', () => {
  const changes = diffMatched({ unit_number: 'T-100', make: 'Utility' }, { unit_number: 'T-100', make: 'utility' });
  assert.deepEqual(changes, [], 'case-only differences are not changes');
});

// ─── the four reconciliation groups ───

const TRAILERS = [
  { id: 1, unit_number: 'T-100', vin: '1ABC', master_status: 'active' },
  { id: 2, unit_number: 'T-200', vin: '2DEF', master_status: 'active' },
];

test('a trailer in both the upload and the database is matched, keeping its ID', () => {
  const result = reconcileSnapshot({
    snapshotRows: [{ unit_number: 'T-100', vin: '1ABC' }],
    trailers: [TRAILERS[0]],
  });
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].trailer.id, 1, 'the database ID is preserved');
  assert.equal(result.matched[0].matched_by, 'unit_number');
});

test('a trailer matched through an alias keeps the canonical record', () => {
  const result = reconcileSnapshot({
    snapshotRows: [{ unit_number: 'T-100-OLD' }],
    trailers: [TRAILERS[0]],
    aliases: [{ alias_unit_number: 'T-100-OLD', trailer_id: 1 }],
  });
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].matched_by, 'alias');
  assert.equal(result.matched[0].trailer.id, 1);
  assert.equal(result.new.length, 0, 'an alias identifies an existing trailer, it never creates one');
});

test('a trailer only in the upload is new and carries suggestions', () => {
  const result = reconcileSnapshot({
    snapshotRows: [{ unit_number: 'T-101' }],
    trailers: [TRAILERS[0]],
  });
  assert.equal(result.new.length, 1);
  assert.equal(result.new[0].row.unit_number, 'T-101');
  assert.ok(result.new[0].suggestions.some((s) => s.unit_number === 'T-100'), 'near-miss is surfaced');
});

test('a trailer only in the database is missing and is never auto-archived', () => {
  const result = reconcileSnapshot({
    snapshotRows: [{ unit_number: 'T-100' }],
    trailers: TRAILERS,
  });
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].trailer.id, 2);
  assert.deepEqual(result.missing[0].available_actions, ['keep_verified', 'archive', 'correct_unit', 'merge']);
  assert.equal(result.summary.requires_review, true, 'a human must decide');
});

test('already archived and merged trailers are not reported missing', () => {
  const result = reconcileSnapshot({
    snapshotRows: [],
    trailers: [
      { id: 3, unit_number: 'T-300', master_status: 'archived' },
      { id: 4, unit_number: 'T-400', master_status: 'merged' },
    ],
  });
  assert.equal(result.missing.length, 0, 'they already left the active master list');
});

test('a conflicting row is quarantined instead of matched or created', () => {
  const result = reconcileSnapshot({
    snapshotRows: [{ unit_number: 'T-100', vin: '1ABC' }, { unit_number: 'T-1OO', vin: '9ZZZ' }],
    trailers: [TRAILERS[0]],
  });
  assert.equal(result.conflicting.length, 2, 'both sides of the confusable pair need review');
  assert.equal(result.matched.length, 0, 'no conflicting record is silently matched');
  assert.equal(result.new.length, 0, 'no conflicting record is silently created');
  assert.equal(result.summary.requires_review, true);
});

test('the summary counts every group', () => {
  const result = reconcileSnapshot({
    snapshotRows: [{ unit_number: 'T-100' }, { unit_number: 'T-999' }],
    trailers: TRAILERS,
  });
  assert.deepEqual(result.summary, {
    snapshot_rows: 2,
    matched: 1,
    new: 1,
    missing: 1,
    conflicting: 0,
    requires_review: true,
  });
});

test('a clean snapshot with no missing or conflicting rows needs no review', () => {
  const result = reconcileSnapshot({
    snapshotRows: [{ unit_number: 'T-100' }, { unit_number: 'T-200' }],
    trailers: TRAILERS,
  });
  assert.equal(result.summary.requires_review, false);
});
