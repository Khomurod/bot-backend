'use strict';

/**
 * The retired-feature cleanup action against a real PostgreSQL database.
 *
 * The whole point of the feature is that it removes leftovers and NOTHING else,
 * so these tests build a database in the shape production is in — the current
 * schema plus the tables a removed feature left behind, holding rows — and then
 * prove three things:
 *
 *   1. dropping the leftovers leaves every surviving table and its rows intact;
 *   2. a CIRCULAR foreign key between two leftovers is still removable — no
 *      ordering of plain `DROP TABLE` can break a cycle, and `trailer_media` ↔
 *      `trailer_invoices` really was one, so the first version of this feature
 *      silently left thirteen of twenty-nine tables behind;
 *   3. a leftover table still referenced from OUTSIDE the allow-list is
 *      reported as blocked rather than cascaded away;
 *   4. the config purge deactivates a retired-only account and deletes the
 *      retired roles and permissions, while leaving the super administrator,
 *      the company-wide permissions and a mixed-role account alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPgHarness, skipWithoutPg } = require('./helpers/pgHarness');

/**
 * A minimal stand-in for what a removed feature left behind: two tables with a
 * foreign key between them, plus rows. `trailers` and `trailer_events` are on
 * the allow-list, so this is the real shape the action will meet in production.
 */
const LEFTOVER_DDL = `
CREATE TABLE trailers (
  id SERIAL PRIMARY KEY,
  unit_number TEXT UNIQUE NOT NULL
);
CREATE TABLE trailer_events (
  id BIGSERIAL PRIMARY KEY,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE CASCADE,
  note TEXT
);
INSERT INTO trailers (unit_number) VALUES ('T-1'), ('T-2');
INSERT INTO trailer_events (trailer_id, note) SELECT id, 'seen' FROM trailers;
CREATE TABLE sos_submissions (id SERIAL PRIMARY KEY, name TEXT);
INSERT INTO sos_submissions (name) VALUES ('anon');
CREATE TABLE fleet_settings (id SERIAL PRIMARY KEY, k TEXT);
`;

async function loadLeftovers(harness) {
  return harness.loadDataLayer(['retiredLeftovers']).retiredLeftovers;
}

test('dropping the leftovers removes them and touches nothing else', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: LEFTOVER_DDL });
  const leftovers = await loadLeftovers(harness);

  const before = await harness.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
  await harness.query("INSERT INTO groups (telegram_group_id, group_name) VALUES (-1001, 'WENZE UNIT # 1 TEST')");

  const inventory = await leftovers.getLeftoverInventory();
  const trailerGroup = inventory.groups.find((g) => g.key === 'trailer');
  assert.equal(trailerGroup.tables_present, 2, 'only the two seeded trailer tables exist');
  assert.equal(trailerGroup.total_rows, 4, 'and their rows are counted (2 trailers + 2 events)');

  const result = await leftovers.dropRetiredTables({ groupKeys: ['trailer', 'qbq_sos', 'fleetview'] });
  assert.deepEqual(result.dropped.sort(), ['fleet_settings', 'sos_submissions', 'trailer_events', 'trailers']);
  assert.deepEqual(result.blocked, [], 'nothing should be blocked in this shape');
  assert.ok(result.already_absent.length > 0, 'tables never created are reported as absent, not failed');

  // The surviving schema is untouched, and so are its rows.
  const after = await harness.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(after.rows[0].n, before.rows[0].n - 4 + 0, 'exactly the four leftover tables are gone');
  const groups = await harness.query('SELECT COUNT(*)::int AS n FROM groups');
  assert.equal(groups.rows[0].n, 1, 'the groups row survives');
  const admins = await harness.query('SELECT COUNT(*)::int AS n FROM admins');
  assert.ok(admins.rows[0].n >= 0, 'admins is still queryable');
});

test('a circular foreign key between two leftovers is still removable', { skip: skipWithoutPg() }, async (t) => {
  // trailer_media referenced trailer_invoices for a receipt, and
  // trailer_invoices referenced trailer_media back. Neither can be dropped
  // while the other stands, and CASCADE is not an option — so the internal
  // foreign keys go first. Nothing outside the doomed set is touched.
  const harness = await createPgHarness(t, {
    extraDdl: `
      CREATE TABLE trailer_invoices (id SERIAL PRIMARY KEY, receipt_id INTEGER);
      CREATE TABLE trailer_media (id SERIAL PRIMARY KEY, invoice_id INTEGER);
      ALTER TABLE trailer_media ADD CONSTRAINT tm_inv_fk
        FOREIGN KEY (invoice_id) REFERENCES trailer_invoices(id);
      ALTER TABLE trailer_invoices ADD CONSTRAINT ti_media_fk
        FOREIGN KEY (receipt_id) REFERENCES trailer_media(id);
      INSERT INTO trailer_invoices (id) VALUES (1);
      INSERT INTO trailer_media (id, invoice_id) VALUES (1, 1);
      UPDATE trailer_invoices SET receipt_id = 1 WHERE id = 1;`,
  });
  const leftovers = await loadLeftovers(harness);

  const both = ['trailer_invoices', 'trailer_media'];
  const internal = await leftovers.internalForeignKeys(harness.pool, both);
  assert.equal(internal.length, 2, 'both directions of the cycle are found');

  const result = await leftovers.dropRetiredTables({ groupKeys: ['trailer'] });
  assert.deepEqual(result.dropped.sort(), both, 'the cycle is gone');
  assert.deepEqual(result.blocked, []);
  assert.equal(result.unlinked_foreign_keys.length, 2, 'and it reports which constraints it removed');
});

test('an internal-foreign-key sweep never touches a constraint pointing outside the set', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, {
    extraDdl: `
      CREATE TABLE trailers (id SERIAL PRIMARY KEY);
      CREATE TABLE keeper (id SERIAL PRIMARY KEY, trailer_id INTEGER REFERENCES trailers(id));`,
  });
  const leftovers = await loadLeftovers(harness);
  const internal = await leftovers.internalForeignKeys(harness.pool, ['trailers']);
  assert.deepEqual(internal, [], 'keeper.trailer_id is not in the doomed set, so it is left alone');
});

test('a leftover still referenced from outside the allow-list is blocked, never cascaded', { skip: skipWithoutPg() }, async (t) => {
  // A surviving table pointing at a leftover is not a shape this application
  // has — but CASCADE would silently delete the referencing rows if it ever
  // did, so the action must refuse instead.
  const harness = await createPgHarness(t, {
    extraDdl: `${LEFTOVER_DDL}
      CREATE TABLE surviving_reference (
        id SERIAL PRIMARY KEY,
        trailer_id INTEGER NOT NULL REFERENCES trailers(id)
      );
      INSERT INTO surviving_reference (trailer_id) SELECT id FROM trailers LIMIT 1;`,
  });
  const leftovers = await loadLeftovers(harness);

  const result = await leftovers.dropRetiredTables({ groupKeys: ['trailer'] });
  assert.equal(result.dropped.includes('trailers'), false, 'trailers cannot be dropped');
  assert.ok(result.blocked.some((b) => b.table === 'trailers'), 'and it is reported as blocked');
  assert.match(result.blocked.find((b) => b.table === 'trailers').reason, /depend|referenc/i);

  const survivors = await harness.query('SELECT COUNT(*)::int AS n FROM surviving_reference');
  assert.equal(survivors.rows[0].n, 1, 'the referencing rows are still there');
});

test('the config purge clears retired RBAC and leaves everything else', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, {
    extraDdl: `
      INSERT INTO roles (system_key, display_name) VALUES
        ('trailer_manager','Trailer Manager'),
        ('trailer_viewer','Trailer Viewer'),
        ('custom_dispatcher','Dispatcher');
      INSERT INTO permissions (permission_key) VALUES
        ('trailers.view'), ('trailer_payments.reverse'), ('dispatch.view');
      INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
         WHERE r.system_key = 'trailer_manager' AND p.permission_key LIKE 'trailer%';
      INSERT INTO admins (username, password_hash) VALUES
        ('trailer-only','x'), ('mixed','y');
      INSERT INTO admin_user_roles (admin_id, role_id)
        SELECT a.id, r.id FROM admins a, roles r
         WHERE a.username = 'trailer-only' AND r.system_key = 'trailer_manager';
      INSERT INTO admin_user_roles (admin_id, role_id)
        SELECT a.id, r.id FROM admins a, roles r
         WHERE a.username = 'mixed' AND r.system_key IN ('trailer_viewer','custom_dispatcher');`,
  });
  const leftovers = await loadLeftovers(harness);

  const inventory = await leftovers.getLeftoverInventory();
  assert.deepEqual(inventory.rbac.roles.map((r) => r.system_key).sort(), ['trailer_manager', 'trailer_viewer']);
  assert.deepEqual(
    inventory.rbac.accounts.map((a) => a.username),
    ['trailer-only'],
    'only the account whose every role is retired is listed',
  );

  const result = await leftovers.purgeRetiredRbac({ actorId: null });
  assert.deepEqual(result.deactivated_accounts.map((a) => a.username), ['trailer-only']);
  assert.deepEqual(result.deleted_roles.sort(), ['trailer_manager', 'trailer_viewer']);
  assert.deepEqual(result.deleted_permissions.sort(), ['trailer_payments.reverse', 'trailers.view']);

  const roles = await harness.query('SELECT system_key FROM roles ORDER BY system_key');
  assert.deepEqual(roles.rows.map((r) => r.system_key), ['custom_dispatcher', 'super_admin']);
  const perms = await harness.query('SELECT permission_key FROM permissions ORDER BY permission_key');
  assert.deepEqual(perms.rows.map((p) => p.permission_key),
    ['admin.full_access', 'dispatch.view', 'roles.manage', 'users.manage']);

  const mixed = await harness.query("SELECT active FROM admins WHERE username = 'mixed'");
  assert.equal(mixed.rows[0].active, true, 'a mixed-role account keeps working');
  const off = await harness.query("SELECT active, auth_version FROM admins WHERE username = 'trailer-only'");
  assert.equal(off.rows[0].active, false);
  assert.ok(off.rows[0].auth_version > 1, 'the auth_version bump invalidates any outstanding token');

  const audit = await harness.query("SELECT action FROM admin_audit_log WHERE action = 'retired_leftovers.purge_config'");
  assert.equal(audit.rows.length, 1, 'the purge is recorded in the admin audit log');
});

test('a drop SURVIVES the next boot — schema.sql does not recreate it', { skip: skipWithoutPg() }, async (t) => {
  // The regression: schema.sql is applied verbatim on EVERY boot, and the
  // baseline still created all five "earlier retired features" tables. So the
  // drop destroyed the rows and the empty tables came back at the next
  // restart, with the inventory reporting them as leftovers again. The operator
  // had done something irreversible and had nothing to show for it.
  //
  // This runs the real thing: apply the real schema.sql, drop through the real
  // action, then apply the real schema.sql AGAIN — which is what a reboot does.
  const harness = await createPgHarness(t);
  const leftovers = await loadLeftovers(harness);

  const tables = leftovers.RETIRED_GROUPS.earlier.tables;
  const present = async () => {
    const res = await harness.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [tables],
    );
    return res.rows.map((row) => row.table_name);
  };

  // A fresh boot must not create them in the first place.
  assert.deepEqual(await present(), [], 'a fresh baseline must not create retired tables');

  // Simulate the deployment that still HAS them — with a row, so the drop is
  // doing real work — then drop them the way the admin action does.
  await harness.query('CREATE TABLE employee_votes_polls (id SERIAL PRIMARY KEY, question TEXT)');
  await harness.query("INSERT INTO employee_votes_polls (question) VALUES ('kept until dropped')");
  assert.deepEqual(await present(), ['employee_votes_polls'], 'seeded the pre-existing table');

  const result = await leftovers.dropRetiredTables({ groupKeys: ['earlier'] });
  assert.ok(
    result.dropped.includes('employee_votes_polls'),
    `expected the drop to report it; saw ${JSON.stringify(result)}`,
  );
  assert.deepEqual(await present(), [], 'and it is gone immediately');

  // The reboot: schema.sql is applied verbatim on every boot.
  await harness.applySchemaSql();

  assert.deepEqual(
    await present(), [],
    'a dropped leftover must not reappear after a restart',
  );
});
