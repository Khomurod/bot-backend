'use strict';

/**
 * Reconciling what the Samsara poller SAW with what the hub STORED.
 *
 * THE TWO NUMBERS USED TO BE INCOMPARABLE. The poller reported `newEvents` for
 * its last poll — almost always zero — and the hub counted `driver_safety_events`
 * over fourteen days. Nothing that could be subtracted from anything, so "events
 * are arriving and not being stored" was invisible in aggregate: the only way to
 * notice was to already suspect it, which is not a health signal.
 *
 * The poller now reports a running total since it booted and the instant it
 * booted. This is the hub's half: how many rows were written in that same
 * period.
 *
 * `created_at`, NOT `occurred_at`, and the distinction is the whole test below.
 * The question is when the row was WRITTEN. A backfilled event has an old
 * `occurred_at` and a window built on it would miss the row entirely — reporting
 * events lost that were in fact recorded, which is the precise inversion of the
 * bug this closes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function harnessWith(t) {
  return createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
}

async function seedEvent(harness, { samsaraId, occurredAt, createdAt }) {
  await harness.query(
    `INSERT INTO driver_safety_events (samsara_event_id, behavior, occurred_at, created_at)
     VALUES ($1, 'harsh_braking', $2, $3)`,
    [samsaraId, occurredAt, createdAt]
  );
}

test('rows written since the poller booted are counted', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { driverSafety } = harness.loadDataLayer(['driverSafety']);

  const booted = '2026-09-20T10:00:00Z';
  await seedEvent(harness, { samsaraId: 'before', occurredAt: booted, createdAt: '2026-09-20T09:00:00Z' });
  await seedEvent(harness, { samsaraId: 'after-1', occurredAt: booted, createdAt: '2026-09-20T11:00:00Z' });
  await seedEvent(harness, { samsaraId: 'after-2', occurredAt: booted, createdAt: '2026-09-20T12:00:00Z' });

  assert.equal(await driverSafety.countRecordedSince(booted), 2,
    'only what was written after the poller started counting');
});

/**
 * A BACKFILLED EVENT IS STILL A RECORDED EVENT. Its `occurred_at` is old; its
 * `created_at` is now. Counting on the wrong column would report it missing and
 * raise a recorder alarm about a row that is sitting right there.
 */
test('an old event recorded now COUNTS — the column is created_at', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { driverSafety } = harness.loadDataLayer(['driverSafety']);

  const booted = '2026-09-20T10:00:00Z';
  await seedEvent(harness, {
    samsaraId: 'backfilled',
    occurredAt: '2026-01-05T08:00:00Z',   // months ago
    createdAt: '2026-09-20T11:00:00Z',    // written after the poller booted
  });

  assert.equal(await driverSafety.countRecordedSince(booted), 1);
});

test('nothing recorded since is zero, not null', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { driverSafety } = harness.loadDataLayer(['driverSafety']);
  assert.equal(await driverSafety.countRecordedSince('2026-09-20T10:00:00Z'), 0,
    'a real zero is an answer; null would mean "could not tell"');
});

/** A missing or unreadable instant answers "cannot tell", never a count. */
test('an unusable instant returns null rather than a number', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { driverSafety } = harness.loadDataLayer(['driverSafety']);
  assert.equal(await driverSafety.countRecordedSince(null), null);
  assert.equal(await driverSafety.countRecordedSince('not a date'), null);
});
