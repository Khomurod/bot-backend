/**
 * Trailer-list review decision rules (pure ESM): archive/merge/number-correction
 * require a reason, merge requires a chosen target, the impact summary reads in
 * plain language, and side-by-side diffs surface real differences only.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mod = () => import(pathToFileURL(path.resolve(
  __dirname, '../admin/src/pages/trailer/masterImport/reconcileDecisions.js',
)).href);

test('archive, merge and number-correction demand a reason; merge needs a target', async () => {
  const { entryIssues } = await mod();
  assert.equal(entryIssues({ action: 'archive', reason: 'Sold in 2024' }).length, 0);
  assert.match(entryIssues({ action: 'archive' })[0], /reason/i);
  assert.match(entryIssues({ action: 'merge', reason: 'duplicate' })[0], /merge into/i);
  assert.equal(entryIssues({ action: 'merge', reason: 'duplicate', merge_into_trailer_id: 7 }).length, 0);
  assert.match(entryIssues({ action: 'correct_unit', reason: 'typo' })[0], /unit number/i);
  // Update and skip stay reason-optional.
  assert.equal(entryIssues({ action: 'update' }).length, 0);
  assert.equal(entryIssues({ action: 'skip' }).length, 0);
  assert.equal(entryIssues(null).length, 0);
});

test('decisions carry the right shape for each group', async () => {
  const { buildDecisions } = await mod();
  const groups = {
    new: [{ row: { import_row_id: 11, unit_number: 'NEW-1', make: 'Wabash' } }],
    matched: [{ trailer: { id: 5 }, row: { import_row_id: 12, plate_number: 'P123' } }],
    conflicting: [],
    missing: [{ trailer: { id: 9 } }],
  };
  const decisions = buildDecisions(groups, {
    'new:11': { action: 'create' },
    'matched:5': { action: 'update', reason: 'plate corrected' },
    'missing:9': { action: 'merge', reason: 'duplicate of 9A', merge_into_trailer_id: '44' },
  });
  assert.equal(decisions.length, 3);
  const create = decisions.find((d) => d.decision === 'create');
  assert.equal(create.unit_number, 'NEW-1');
  assert.equal(create.make, 'Wabash');
  const update = decisions.find((d) => d.decision === 'update');
  assert.equal(update.trailer_id, 5);
  assert.equal(update.plate_number, 'P123');
  const merge = decisions.find((d) => d.decision === 'merge');
  assert.equal(merge.merge_into_trailer_id, 44, 'merge target is numeric');
});

test('the impact summary reads as one plain sentence', async () => {
  const { impactSummary } = await mod();
  assert.equal(impactSummary([]), 'No changes selected yet.');
  const text = impactSummary([
    { decision: 'create' }, { decision: 'create' },
    { decision: 'update' }, { decision: 'archive' }, { decision: 'merge' },
  ]);
  assert.match(text, /add 2 trailers/);
  assert.match(text, /update 1/);
  assert.match(text, /archive 1/);
  assert.match(text, /merge 1/);
  assert.match(text, /Nothing is deleted/);
});

test('field diffs list only genuine differences', async () => {
  const { fieldDiffs } = await mod();
  const diffs = fieldDiffs(
    { make: 'Wabash', plate_number: 'P1', vin: null },
    { make: 'Wabash', plate_number: 'P2', vin: 'VIN9', year: '' },
  );
  assert.deepEqual(diffs.map((d) => d.field).sort(), ['plate_number', 'vin']);
  const plate = diffs.find((d) => d.field === 'plate_number');
  assert.equal(plate.current, 'P1');
  assert.equal(plate.incoming, 'P2');
});
