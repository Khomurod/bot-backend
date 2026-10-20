'use strict';

/**
 * Migration 0072 drops three indexes that duplicate a UNIQUE constraint's own
 * index — and only where that constraint really exists, because on an old copy
 * of the database the index can be the one thing keeping a column unique.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../database/migrations/0072_drop_duplicate_indexes.sql'), 'utf8'
);
const DUPLICATES = [
  'idx_driver_profiles_group_id',
  'idx_group_pinned_messages_group_id',
  'idx_facebook_lead_sms_mirrors_lookup',
];

async function indexNames(h) {
  const res = await h.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1)",
    [DUPLICATES]
  );
  return res.rows.map((r) => r.indexname).sort();
}

test('a fresh database has none of the duplicates, and the columns stay unique', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  assert.deepEqual(await indexNames(h), []);

  const group = (await h.query(
    "INSERT INTO groups (telegram_group_id, group_name) VALUES (-100123, 'G') RETURNING id"
  )).rows[0].id;
  await h.query('INSERT INTO driver_profiles (group_id) VALUES ($1)', [group]);
  await assert.rejects(
    h.query('INSERT INTO driver_profiles (group_id) VALUES ($1)', [group]),
    /duplicate key/
  );
});

test('the migration drops a duplicate where the constraint covers it, and is idempotent', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  await h.query('CREATE UNIQUE INDEX idx_driver_profiles_group_id ON driver_profiles(group_id)');
  await h.query('CREATE INDEX idx_facebook_lead_sms_mirrors_lookup ON facebook_lead_sms_mirrors (telegram_chat_id, telegram_message_id)');
  await h.query(MIGRATION);
  await h.query(MIGRATION);
  assert.deepEqual(await indexNames(h), []);
});

test('AN OLD COPY WITHOUT THE CONSTRAINT KEEPS ITS INDEX — the only uniqueness it has', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  await h.query('ALTER TABLE driver_profiles DROP CONSTRAINT driver_profiles_group_id_unique');
  await h.query('CREATE UNIQUE INDEX idx_driver_profiles_group_id ON driver_profiles(group_id)');
  await h.query(MIGRATION);
  assert.deepEqual(await indexNames(h), ['idx_driver_profiles_group_id']);
});
