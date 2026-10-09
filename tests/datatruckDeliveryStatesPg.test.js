'use strict';

/**
 * The BOL/POD scan's one read per pass — against a real PostgreSQL.
 *
 * A scan covers a week of documents and used to upsert and read back a full
 * delivery row for every one of them on every pass (October 2026: ~100 MB a
 * day of database transfer). It now asks once, for the whole window, where
 * each document stands, and only the columns the routing decides on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

test('getDeliveryStates: one read, keyed by signature, only the deciding columns', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { datatruckDocuments: docs } = harness.loadDataLayer(['datatruckDocuments']);

  const meta = (signature) => ({
    signature, orderId: 'o-1', loadReference: 'L-1', fileType: 'bill_of_lading',
    fileLink: 'x.pdf', uploadedBy: 'Jane', uploadedAt: '2026-10-01T00:00:00Z',
  });
  const { row } = await docs.upsertDelivery(meta('sig-sent'));
  await docs.markDestinationSent(row.id, 'driver', { telegramGroupId: '-1001', messageId: 7 });
  await docs.recordBackfillSuppressed(meta('sig-old'));

  const states = await docs.getDeliveryStates(['sig-sent', 'sig-old', 'sig-never-seen', 'sig-sent', null]);
  assert.deepEqual([...states.keys()].sort(), ['sig-old', 'sig-sent'], 'unknown documents are simply absent');
  assert.deepEqual(Object.keys(states.get('sig-sent')).sort(),
    ['attempt_count', 'central_attempt_count', 'central_status', 'id', 'signature', 'status']);
  assert.equal(states.get('sig-sent').status, 'sent');
  assert.equal(states.get('sig-old').status, 'suppressed_backfill');
  assert.equal(states.get('sig-old').central_status, 'skipped_not_applicable',
    'the column default the settled rule relies on');

  assert.deepEqual(await docs.getDeliveryStates([]), new Map(), 'no documents, no query');
});
