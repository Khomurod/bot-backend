/**
 * Migration 0012 and its data layer against a REAL PostgreSQL.
 *
 * What only a real database can prove: the table applies on top of the
 * accumulated baseline, re-running it is a no-op (schema.sql-style boots are
 * idempotent per CLAUDE.md), one recruiter can hold at most one template, the
 * row disappears with its recruiter, and — the behaviour the feature rests on —
 * a blank template DELETES rather than storing an empty string, so "no custom
 * message" has exactly one representation.
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
  __dirname, '..', 'database', 'migrations', '0012_facebook_lead_recruiter_messages.sql'
);
const MIGRATION = fs.readFileSync(MIGRATION_PATH, 'utf8');
const ALL_MIGRATIONS = allMigrationsSql();

async function seedRecruiters(harness) {
  const res = await harness.query(
    `INSERT INTO recruiters (name, phone_number, phone_number_normalized, active)
     VALUES ('Sofia', '+15550000011', '5550000011', TRUE),
            ('Kimberly', '+15550000012', '5550000012', TRUE),
            ('Jaime', '+15550000013', '5550000013', TRUE),
            ('Retired Rita', '+15550000014', '5550000014', FALSE)
     RETURNING id, name`
  );
  return new Map(res.rows.map((row) => [row.name, row.id]));
}

test('the migration applies to the baseline and re-applies as a no-op', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: MIGRATION });
  await harness.query(MIGRATION); // second boot

  const columns = await harness.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'facebook_lead_recruiter_messages'`
  );
  const byName = new Map(columns.rows.map((r) => [r.column_name, r]));
  for (const column of ['recruiter_id', 'message_template', 'is_enabled', 'updated_by', 'created_at', 'updated_at']) {
    assert.ok(byName.has(column), `facebook_lead_recruiter_messages.${column} must exist`);
  }
  assert.equal(byName.get('message_template').is_nullable, 'YES');
});

test('one template per recruiter, and it dies with the recruiter', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const ids = await seedRecruiters(harness);

  await harness.query(
    'INSERT INTO facebook_lead_recruiter_messages (recruiter_id, message_template) VALUES ($1, $2)',
    [ids.get('Sofia'), 'Sofia here.']
  );
  await assert.rejects(
    () => harness.query(
      'INSERT INTO facebook_lead_recruiter_messages (recruiter_id, message_template) VALUES ($1, $2)',
      [ids.get('Sofia'), 'Sofia again.']
    ),
    /duplicate key|unique/i,
    'a recruiter cannot hold two templates',
  );

  await harness.query('DELETE FROM recruiters WHERE id = $1', [ids.get('Sofia')]);
  const left = await harness.query('SELECT COUNT(*)::int AS n FROM facebook_lead_recruiter_messages');
  assert.equal(left.rows[0].n, 0, 'ON DELETE CASCADE leaves no orphan template');
});

test('the data layer lists every active recruiter and round-trips a template', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const ids = await seedRecruiters(harness);
  const { facebookLeads } = harness.loadDataLayer(['facebookLeads']);

  // Every ACTIVE recruiter appears, template or not — that is what makes a
  // newly hired recruiter show up in the admin panel with no code change.
  const initial = await facebookLeads.listFacebookLeadRecruiterMessages();
  assert.deepEqual(initial.map((r) => r.recruiter_name).sort(), ['Jaime', 'Kimberly', 'Sofia']);
  assert.ok(initial.every((r) => r.message_template == null));

  await facebookLeads.replaceFacebookLeadRecruiterMessages([
    { recruiter_id: ids.get('Sofia'), message_template: 'Hi {first_name}, Sofia here.' },
    { recruiter_id: ids.get('Kimberly'), message_template: '  ' },
  ], { updatedBy: 'admin' });

  assert.equal(
    (await facebookLeads.getFacebookLeadRecruiterMessage(ids.get('Sofia'))).message_template,
    'Hi {first_name}, Sofia here.',
  );
  assert.equal(
    await facebookLeads.getFacebookLeadRecruiterMessage(ids.get('Kimberly')),
    null,
    'a blank template is stored as no row at all',
  );

  // Clearing a saved template removes it rather than leaving an empty string.
  await facebookLeads.replaceFacebookLeadRecruiterMessages([
    { recruiter_id: ids.get('Sofia'), message_template: '' },
  ]);
  assert.equal(await facebookLeads.getFacebookLeadRecruiterMessage(ids.get('Sofia')), null);
  const rows = await harness.query('SELECT COUNT(*)::int AS n FROM facebook_lead_recruiter_messages');
  assert.equal(rows.rows[0].n, 0);
});

test('a parked template reads as no override', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const ids = await seedRecruiters(harness);
  const { facebookLeads } = harness.loadDataLayer(['facebookLeads']);

  await facebookLeads.replaceFacebookLeadRecruiterMessages([
    { recruiter_id: ids.get('Jaime'), message_template: 'Jaime here.', is_enabled: false },
  ]);

  assert.equal(
    await facebookLeads.getFacebookLeadRecruiterMessage(ids.get('Jaime')),
    null,
    'parked means the global message is used…',
  );
  const listed = (await facebookLeads.listFacebookLeadRecruiterMessages())
    .find((r) => r.recruiter_id === ids.get('Jaime'));
  assert.equal(listed.message_template, 'Jaime here.', '…but the text is kept for the admin panel');
  assert.equal(listed.is_enabled, false);
});
