/**
 * Migration 0011 against a REAL PostgreSQL, on the real baseline schema.
 *
 * `facebook_lead_sms_mirrors.fallback_reason` answers the question the row
 * could not: a NULL `recruiter_id` already said the shared company number sent
 * this conversation, but not whether that was routine ("nobody mapped yet") or
 * something an operator should fix today ("their number is not on their
 * extension"). That distinction only ever existed in the Telegram note, which
 * nothing can query.
 *
 * What a unit test cannot show: that the column applies to the accumulated
 * schema, is idempotent on a boot that already has it, is nullable so every
 * pre-existing row stays valid, and — deliberately — is NOT constrained to a
 * fixed list, so a new reason never costs a lead its mirror row.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a
 * passing test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const migrationSql = (name) => fs.readFileSync(
  path.join(__dirname, '..', 'database', 'migrations', name), 'utf8',
);

// 0011 adds a column to a table 0008 also extends (`recruiter_id`,
// `from_number`), and the writes below go THROUGH the data layer — so the
// harness gets every migration in order, exactly as a real boot applies them.
const MIGRATION = allMigrationsSql();
const MIGRATION_0011 = migrationSql('0011_sms_mirror_fallback_reason.sql');

async function mirrorColumn(harness, name) {
  const res = await harness.query(
    `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'facebook_lead_sms_mirrors'
        AND column_name = $1`,
    [name]
  );
  return res.rows[0] || null;
}

test('the migration adds a nullable fallback_reason', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });

  const column = await mirrorColumn(harness, 'fallback_reason');
  assert.ok(column, 'facebook_lead_sms_mirrors.fallback_reason must exist');
  assert.equal(column.data_type, 'text');
  assert.equal(
    column.is_nullable, 'YES',
    'every row written before this column, and every recruiter-sent row, has none',
  );
});

test('re-applying it is a no-op, as a boot must be', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  // The baseline runs verbatim on every boot and the runner records a
  // migration once, but idempotency is the property that makes a re-run safe.
  await harness.query(MIGRATION_0011);
  await harness.query(MIGRATION_0011);
  assert.ok(await mirrorColumn(harness, 'fallback_reason'));
});

test('a reason round-trips, and an unknown one is stored rather than refused', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  const { facebookLeads } = harness.loadDataLayer(['facebookLeads']);

  const withReason = await facebookLeads.insertFacebookLeadSmsMirror({
    telegramChatId: -5231255301,
    telegramMessageId: 501,
    driverPhone: '+15559998888',
    smsBody: 'Hi Alex',
    fromNumber: '+14704804679',
    recruiterId: null,
    fallbackReason: 'recruiter_number_not_on_extension',
  });
  assert.equal(withReason.fallback_reason, 'recruiter_number_not_on_extension');
  assert.equal(withReason.recruiter_id, null);
  assert.equal(withReason.source_type, 'outbound_auto');

  // A recruiter-sent conversation has nothing to explain.
  const noReason = await facebookLeads.insertFacebookLeadSmsMirror({
    telegramChatId: -5231255301,
    telegramMessageId: 502,
    driverPhone: '+15559998888',
    smsBody: 'Hi Alex',
    fromNumber: '+15557770000',
    recruiterId: null,
  });
  assert.equal(noReason.fallback_reason, null);

  // No CHECK and no enum, on purpose: adding a reason to the code must not
  // need a migration, and an unrecognized value is a logging gap — never a
  // write failure that would cost the lead its reply anchor.
  const future = await facebookLeads.insertFacebookLeadSmsMirror({
    telegramChatId: -5231255301,
    telegramMessageId: 503,
    driverPhone: '+15559998888',
    smsBody: 'Hi Alex',
    fallbackReason: 'some_reason_invented_later',
  });
  assert.equal(future.fallback_reason, 'some_reason_invented_later');
});

test('the upsert keeps the reason in step with the row it replaces', { skip: skipWithoutPg() }, async (t) => {
  // The mirror is keyed on (telegram_chat_id, telegram_message_id) and upserts.
  // A stale reason surviving an update would misreport a conversation that has
  // since been repaired.
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  const { facebookLeads } = harness.loadDataLayer(['facebookLeads']);

  const key = { telegramChatId: -5231255301, telegramMessageId: 777 };
  await facebookLeads.insertFacebookLeadSmsMirror({
    ...key,
    driverPhone: '+15559998888',
    smsBody: 'Hi',
    fallbackReason: 'unassigned',
  });
  const updated = await facebookLeads.insertFacebookLeadSmsMirror({
    ...key,
    driverPhone: '+15559998888',
    smsBody: 'Hi',
    recruiterId: null,
    fallbackReason: null,
  });
  assert.equal(updated.fallback_reason, null, 'the reason follows the write, not the history');
});
