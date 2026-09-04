/**
 * The scheduled-messages queue query, against a real PostgreSQL.
 *
 * WHY A DATABASE TEST. getAllScheduledMessages used to be
 * `SELECT * FROM scheduled_messages ORDER BY created_at DESC` — every row ever
 * created, each carrying three full message texts and a media_items JSONB blob,
 * re-read on a timer for as long as an admin tab stayed open. It is now a
 * UNION: all live rows, plus a bounded tail of finished history. A UNION with a
 * subquery and an outer ORDER BY is exactly the kind of SQL that a unit test
 * with a fake pool would happily "pass" while production returned a 500, so it
 * is exercised against the real schema here.
 *
 * Requires TEST_DATABASE_URL (CI provides a Postgres 16 service container).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

/** Insert one row and return it. */
async function insert(harness, { status, text, createdAt }) {
  const res = await harness.query(
    `INSERT INTO scheduled_messages (message_text_en, status, scheduled_at, created_at)
     VALUES ($1, $2, NOW(), $3) RETURNING id, status, created_at`,
    [text, status, createdAt],
  );
  return res.rows[0];
}

test('the queue keeps every live message and caps finished history', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { scheduledMessages } = harness.loadDataLayer(['scheduledMessages']);

  const base = Date.parse('2026-01-01T00:00:00Z');
  const at = (minutes) => new Date(base + minutes * 60_000).toISOString();

  // Two still-to-send rows and five finished ones, oldest first.
  const pendingA = await insert(harness, { status: 'pending', text: 'pending A', createdAt: at(0) });
  const pendingB = await insert(harness, { status: 'processing', text: 'processing B', createdAt: at(1) });
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- ordered inserts, ordering is the point
    await insert(harness, { status: 'sent', text: `sent ${i}`, createdAt: at(10 + i) });
  }
  await insert(harness, { status: 'cancelled', text: 'cancelled', createdAt: at(20) });

  const rows = await scheduledMessages.getAllScheduledMessages({ historyLimit: 2 });
  const texts = rows.map((r) => r.message_text_en);

  assert.ok(texts.includes('pending A'), 'a pending message must never be dropped');
  assert.ok(texts.includes('processing B'), 'a processing message must never be dropped');
  // The two newest finished rows, and nothing older.
  assert.ok(texts.includes('cancelled'), 'the newest finished row is kept');
  assert.ok(texts.includes('sent 4'), 'the second-newest finished row is kept');
  assert.ok(!texts.includes('sent 0'), 'older finished history is not re-sent every poll');
  assert.equal(rows.length, 4, `expected 2 live + 2 history, got ${texts.join(', ')}`);

  // Newest first, as the page renders it.
  const createdAtOrder = rows.map((r) => new Date(r.created_at).getTime());
  assert.deepEqual(
    createdAtOrder,
    [...createdAtOrder].sort((a, b) => b - a),
    'rows must come back newest first',
  );

  // Ids survive the UNION, so cancel/send-now still address the right row.
  assert.ok(rows.some((r) => r.id === pendingA.id));
  assert.ok(rows.some((r) => r.id === pendingB.id));
});

test('the default call is valid SQL and returns the queue', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { scheduledMessages } = harness.loadDataLayer(['scheduledMessages']);

  await insert(harness, { status: 'pending', text: 'only one', createdAt: new Date().toISOString() });
  const rows = await scheduledMessages.getAllScheduledMessages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_text_en, 'only one');
});

test('an empty table returns an empty list rather than failing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const { scheduledMessages } = harness.loadDataLayer(['scheduledMessages']);
  assert.deepEqual(await scheduledMessages.getAllScheduledMessages(), []);
});
