/**
 * Migration 0013 against a REAL PostgreSQL.
 *
 * What only a real database can prove: the two tables apply on top of the
 * accumulated baseline, re-running is a no-op, the settings row is seeded so a
 * fresh deployment already has the shipped defaults, the CHECK constraints
 * really do refuse an impossible recovery configuration, and — the property the
 * whole feature rests on — `samsara_event_id` is UNIQUE, so one event can never
 * hold two recoveries and therefore never produce two Samsara retrieval
 * requests.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a passing
 * test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const MIGRATION_PATH = path.join(
  __dirname, '..', 'database', 'migrations', '0013_samsara_settings_and_video_recovery.sql'
);
const MIGRATION = fs.readFileSync(MIGRATION_PATH, 'utf8');
const ALL_MIGRATIONS = allMigrationsSql();

test('the migration applies, re-applies, and seeds a row that changes nothing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  await harness.query(MIGRATION); // a second boot must change nothing

  const rows = await harness.query('SELECT * FROM samsara_settings');
  assert.equal(rows.rows.length, 1, 'exactly one settings row, seeded');
  const row = rows.rows[0];
  assert.equal(row.enabled, true, 'Samsara has always been on, and stays on');
  assert.equal(row.api_key_encrypted, null, 'nothing is stored until an admin saves one');

  // EVERY OPERATIONAL COLUMN IS NULL, and NULL means "inherit the environment".
  // SQL defaults here would make the seeded row indistinguishable from one an
  // administrator saved — so this migration would silently overwrite a deployed
  // SAMSARA_MAX_VIDEO_BYTES or SAMSARA_VIDEO_RETRY_DELAY_MS the moment it ran.
  for (const column of [
    'speeding_events_enabled', 'max_video_megabytes',
    'video_recovery_enabled', 'video_recovery_initial_delay_seconds',
    'video_retrieval_enabled', 'video_recovery_retry_interval_seconds',
    'video_recovery_max_attempts',
    'video_retrieval_window_before_seconds', 'video_retrieval_window_after_seconds',
  ]) {
    assert.equal(row[column], null, `${column} must be NULL so the environment still decides`);
  }

  const columns = await harness.query(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'samsara_settings'`
  );
  for (const c of columns.rows) {
    if (['id', 'enabled', 'updated_at'].includes(c.column_name)) continue;
    assert.equal(c.is_nullable, 'YES', `${c.column_name} must be nullable`);
    assert.equal(c.column_default, null, `${c.column_name} must carry no SQL default`);
  }
});

test('the shipped defaults come from code, and reach both services', { skip: skipWithoutPg() }, async (t) => {
  // With the row seeded NULL, the effective values an operator sees are the
  // ones in database/samsaraSettings.js DEFAULTS — including the 5-minute
  // initial delay the admin panel shows.
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { samsaraSettings } = harness.loadDataLayer(['samsaraSettings']);

  const view = await samsaraSettings.getSamsaraSettingsForAdmin();
  assert.equal(view.videoRecoveryEnabled, true);
  assert.equal(view.videoRecoveryInitialDelaySeconds, 300, 'the 5 minutes the admin panel shows');
  assert.equal(view.videoRetrievalEnabled, true);
  assert.equal(view.videoRecoveryMaxAttempts, 12);

  // …and a saved value is what then overrides them.
  await samsaraSettings.updateSamsaraSettings({ videoRecoveryInitialDelaySeconds: 600 });
  const saved = await harness.query('SELECT video_recovery_initial_delay_seconds FROM samsara_settings WHERE id = 1');
  assert.equal(saved.rows[0].video_recovery_initial_delay_seconds, 600);
});

test('an impossible recovery configuration is refused by the database', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });

  await assert.rejects(
    () => harness.query('UPDATE samsara_settings SET video_recovery_initial_delay_seconds = 0 WHERE id = 1'),
    /violates check constraint/,
    'a zero-second delay would be a tight loop against Samsara',
  );
  await assert.rejects(
    () => harness.query('UPDATE samsara_settings SET video_retrieval_window_after_seconds = 0 WHERE id = 1'),
    /violates check constraint/,
    'a zero-length window is the bug this whole change exists to fix',
  );
  // …and a legitimate five-minute configuration is accepted.
  await harness.query(
    'UPDATE samsara_settings SET video_recovery_initial_delay_seconds = 300, video_recovery_retry_interval_seconds = 300 WHERE id = 1'
  );
});

test('one event can hold at most one recovery', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });

  const insert = `INSERT INTO samsara_video_recovery_jobs (samsara_event_id, vehicle_id, targets)
                  VALUES ($1, $2, $3::jsonb)`;
  await harness.query(insert, ['evt-1', 'veh-9', JSON.stringify([{ chatId: '-1', messageId: 5 }])]);

  await assert.rejects(
    () => harness.query(insert, ['evt-1', 'veh-9', '[]']),
    /duplicate key|unique/i,
    'a re-delivered event must not start a second recovery',
  );

  // The idempotent form the poller actually uses.
  const again = await harness.query(
    `${insert} ON CONFLICT (samsara_event_id) DO NOTHING RETURNING id`,
    ['evt-1', 'veh-9', '[]']
  );
  assert.equal(again.rows.length, 0, 'ON CONFLICT DO NOTHING is a clean no-op');
});

test('only the states the worker knows are storable', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    'INSERT INTO samsara_video_recovery_jobs (samsara_event_id, targets) VALUES ($1, $2::jsonb)',
    ['evt-2', '[]']
  );
  for (const status of ['pending_recheck', 'pending_retrieval', 'video_available', 'completed', 'no_video', 'failed']) {
    await harness.query('UPDATE samsara_video_recovery_jobs SET status = $1 WHERE samsara_event_id = $2', [status, 'evt-2']);
  }
  await assert.rejects(
    () => harness.query('UPDATE samsara_video_recovery_jobs SET status = $1 WHERE samsara_event_id = $2', ['lost', 'evt-2']),
    /violates check constraint/,
    'there is no silent "we stopped caring" state',
  );
});

test('the admin read layer summarises the queue without exposing payloads', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { samsaraVideoRecovery } = harness.loadDataLayer(['samsaraVideoRecovery']);

  await harness.query(
    `INSERT INTO samsara_video_recovery_jobs (samsara_event_id, vehicle_id, status, targets, raw_event, attempts)
     VALUES ('evt-a', 'veh-1', 'pending_retrieval', $1::jsonb, $2::jsonb, 2),
            ('evt-b', 'veh-2', 'completed', '[]'::jsonb, '{}'::jsonb, 1)`,
    [
      JSON.stringify([{ botKind: 'notification', chatId: '-1', messageId: 5, caption: 'Harsh braking' }]),
      JSON.stringify({ id: 'evt-a', secretish: 'https://signed.example/clip.mp4?Signature=abc' }),
    ]
  );

  const summary = await samsaraVideoRecovery.getSamsaraVideoRecoverySummary();
  assert.equal(summary.available, true);
  assert.equal(summary.byStatus.pending_retrieval, 1);
  assert.equal(summary.byStatus.completed, 1);
  assert.equal(summary.byStatus.failed, 0, 'every state is present, zero-filled');

  const jobs = await samsaraVideoRecovery.listSamsaraVideoRecoveryJobs({ limit: 10 });
  assert.equal(jobs.length, 2);
  const serialized = JSON.stringify(jobs);
  assert.equal(serialized.includes('Signature=abc'), false, 'no signed media URL leaves the data layer');
  assert.equal(serialized.includes('Harsh braking'), false, 'nor the message payloads');
  assert.equal(jobs.find((j) => j.samsara_event_id === 'evt-a').target_count, 1);
});
