'use strict';

/**
 * Regression guard: the legacy screenshot importer must never again be a second,
 * unreviewed trailer-creation authority.
 *
 * Before this fix, `commitRows` upserted parsed rows straight into the trailers
 * master list with source 'screenshot_import', minting official trailers with no
 * complete-snapshot confirmation, no matched/new/missing/conflicting review, and
 * no reconciliation-log entry. Trailer creation from images must now flow only
 * through the master-list import + reconciliation pipeline.
 *
 * These tests assert, statically and behaviorally, that the bypass stays closed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const trailerImport = require('../services/trailerImportService');

test('commitRows is disabled and refuses to write to the master list', async () => {
  await assert.rejects(
    () => trailerImport.commitRows(1, [{ unit_number: 'T-500' }]),
    (err) => err.code === 'LEGACY_IMPORT_DISABLED' && err.status === 410,
    'commitRows must throw LEGACY_IMPORT_DISABLED rather than upsert trailers',
  );
});

test('commitRows no longer calls any trailer-creation write', () => {
  // Static proof: the disabled implementation must not reference the general
  // upsert or the batch-committed marker — a future edit that reintroduces them
  // would resurrect the bypass and fail this test.
  const src = fs.readFileSync(
    path.resolve(__dirname, '../services/trailerImportService.js'),
    'utf8',
  );
  const commitBody = src.slice(src.indexOf('async function commitRows'));
  const nextFn = commitBody.indexOf('\nasync function ', 1);
  const body = nextFn === -1 ? commitBody : commitBody.slice(0, nextFn);
  assert.ok(
    !/upsertTrailerByUnitNumber/.test(body),
    'commitRows must not call upsertTrailerByUnitNumber',
  );
  assert.ok(
    !/markImportBatchCommitted/.test(body),
    'commitRows must not mark a batch committed (that was the bypass)',
  );
});

test('the legacy commit route returns 410 and never invokes commitRows', () => {
  // The route file must return a 410 for the legacy commit endpoint and must not
  // await trailerImport.commitRows(...) with request rows anymore.
  const routes = fs.readFileSync(
    path.resolve(__dirname, '../server/routes/trailerRoutes.js'),
    'utf8',
  );
  const idx = routes.indexOf("/api/trailers/import/:batchId/commit");
  assert.ok(idx !== -1, 'legacy commit route still declared');
  const handler = routes.slice(idx, idx + 600);
  assert.ok(/410/.test(handler), 'legacy commit route must respond 410');
  assert.ok(
    !/commitRows\(/.test(handler),
    'legacy commit route must not call commitRows anymore',
  );
});
