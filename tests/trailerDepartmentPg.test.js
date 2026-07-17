/**
 * Trailer Department migration against a real PostgreSQL.
 *
 * Covers the guarantees that only a live database can prove:
 *   - schema.sql is idempotent (it re-runs on EVERY boot);
 *   - the seeded Trailer login works on a fresh database and its password is
 *     NEVER reset afterwards — a Definition-of-Done item;
 *   - pre-existing admins keep their password and gain super_admin;
 *   - the exclusion constraint really does reject overlapping rentals.
 *
 * Requires TEST_DATABASE_URL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

test('trailer department migration reruns, seeds safely, and rejects rental overlap', {
  skip: skipWithoutPg(),
  timeout: 60000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);

  await t.test('the seeded Trailer login works on a fresh database', async () => {
    const res = await harness.query(
      `SELECT a.password_hash, r.system_key
         FROM admins a
         JOIN admin_user_roles aur ON aur.admin_id = a.id
         JOIN roles r ON r.id = aur.role_id
        WHERE a.username = 'Trailer'`,
    );
    assert.equal(await bcrypt.compare('Trailer123', res.rows[0].password_hash), true);
    assert.equal(res.rows[0].system_key, 'trailer_manager');
  });

  await t.test('a changed Trailer password is NEVER reset by a later boot', async () => {
    // The seed is ON CONFLICT DO NOTHING; if it ever became an UPSERT, every
    // deploy would silently restore the default password.
    await harness.query(`UPDATE admins SET password_hash = 'changed-by-user' WHERE username = 'Trailer'`);
    await harness.applyDepartmentSchema();
    await harness.applyDepartmentSchema();

    const res = await harness.query(`SELECT password_hash FROM admins WHERE username = 'Trailer'`);
    assert.equal(res.rows[0].password_hash, 'changed-by-user');
  });

  await t.test('a pre-existing admin keeps its password and gains super_admin', async () => {
    const hash = await bcrypt.hash('preserve-me', 4);
    await harness.query(`INSERT INTO admins (username, password_hash) VALUES ('existing', $1)`, [hash]);

    await harness.applyDepartmentSchema();

    const res = await harness.query(
      `SELECT a.password_hash, r.system_key
         FROM admins a
         JOIN admin_user_roles aur ON aur.admin_id = a.id
         JOIN roles r ON r.id = aur.role_id
        WHERE a.username = 'existing'`,
    );
    assert.equal(res.rows[0].password_hash, hash, 'an existing password is never touched');
    assert.equal(res.rows[0].system_key, 'super_admin', 'admins from before RBAC keep full access');
  });

  await t.test('two overlapping scheduled rentals cannot both be created', async () => {
    const trailer = await harness.query(
      `INSERT INTO trailers (unit_number, physical_status, needs_review)
       VALUES ('T-OVERLAP', 'available', FALSE) RETURNING id`,
    );
    const company = await harness.query(
      `INSERT INTO trailer_renter_companies (legal_name, display_name) VALUES ('Acme LLC', 'Acme') RETURNING id`,
    );
    const insert = `INSERT INTO trailer_rentals
        (agreement_number, trailer_id, company_id, status, start_at, expected_return_at, daily_rate)
      VALUES ($1, $2, $3, 'scheduled', '2026-01-01', '2026-01-10', 100)`;

    // Raced on purpose: the guarantee has to come from the database, not from
    // application-level checking.
    const [a, b] = await Promise.all([harness.connect(), harness.connect()]);
    try {
      const results = await Promise.allSettled([
        a.query(insert, ['RENT-2026-000001', trailer.rows[0].id, company.rows[0].id]),
        b.query(insert, ['RENT-2026-000002', trailer.rows[0].id, company.rows[0].id]),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one wins');
      assert.equal(
        results.find((r) => r.status === 'rejected').reason.code,
        '23P01',
        'the loser is rejected by the exclusion constraint',
      );
    } finally {
      a.release();
      b.release();
    }
  });
});
