/**
 * Per-check auto-apply permission, and the RBAC permission that guards it.
 *
 * The sharp edge here is migration 0018's second statement. The baseline grants
 * super_admin every permission with a CROSS JOIN **at seed time only**, so a
 * permission added later is held by nobody until it is explicitly back-filled.
 * A migration that inserted the permission row and stopped would have locked
 * every existing administrator out of the feature it was written to enable —
 * and it would have looked completely correct in review.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function harnessWith(t) {
  return createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
}

test('the apply permission exists and super admins actually hold it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);

  const perm = await harness.query(
    "SELECT * FROM permissions WHERE permission_key = 'operations.corrections.apply'"
  );
  assert.equal(perm.rows.length, 1, 'the permission row exists');

  const granted = await harness.query(
    `SELECT 1 FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.system_key = 'super_admin' AND p.permission_key = 'operations.corrections.apply'`
  );
  assert.equal(granted.rows.length, 1,
    'the baseline CROSS JOIN runs at seed time only — without the back-fill nobody holds this');
});

test('an admin resolves the new permission through getAdminAuthorization', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { rbac } = harness.loadDataLayer(['rbac']);

  const admin = await harness.query(
    "INSERT INTO admins (username, password_hash) VALUES ('opsadmin','x') RETURNING id"
  );
  const adminId = admin.rows[0].id;
  await harness.query(
    `INSERT INTO admin_user_roles (admin_id, role_id)
     SELECT $1, id FROM roles WHERE system_key = 'super_admin'`,
    [adminId]
  );

  const auth = await rbac.getAdminAuthorization(adminId);
  assert.ok(auth.permissions.includes('admin.full_access'));
  assert.ok(auth.permissions.includes('operations.corrections.apply'),
    'this is what the route gate reads on every request');
});

test('a role with full access but not the apply permission can look, not touch',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { rbac } = harness.loadDataLayer(['rbac']);

    const role = await harness.query(
      "INSERT INTO roles (display_name, description) VALUES ('Ops Viewer','Read only') RETURNING id"
    );
    await harness.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE permission_key = 'admin.full_access'`,
      [role.rows[0].id]
    );
    const admin = await harness.query(
      "INSERT INTO admins (username, password_hash) VALUES ('viewer','x') RETURNING id"
    );
    await harness.query(
      'INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, $2)',
      [admin.rows[0].id, role.rows[0].id]
    );

    const auth = await rbac.getAdminAuthorization(admin.rows[0].id);
    assert.ok(auth.permissions.includes('admin.full_access'), 'the page is readable');
    assert.equal(auth.permissions.includes('operations.corrections.apply'), false,
      'and the fleet is not changeable — the entire reason the permission was added');
  });

test('the migration re-applies as a no-op', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const before = await harness.query('SELECT COUNT(*)::int AS n FROM role_permissions');

  await harness.applySchemaSql(ALL_MIGRATIONS);

  const after = await harness.query('SELECT COUNT(*)::int AS n FROM role_permissions');
  assert.equal(after.rows[0].n, before.rows[0].n, 'ON CONFLICT DO NOTHING, both statements');
  const perms = await harness.query(
    "SELECT COUNT(*)::int AS n FROM permissions WHERE permission_key = 'operations.corrections.apply'"
  );
  assert.equal(perms.rows[0].n, 1);
});

// ─── the settings themselves ─────────────────────────────────────────────────

test('the schema seeds no rows — only migration 0027\'s three switches exist, each saying who set it',
  { skip: skipWithoutPg() }, async (t) => {
    // Default deny is the schema's rule: a check with no row is disabled. The
    // only rows that exist without a person's click are the three the owner
    // asked for on 2026-09-10, and each row names the migration as its author,
    // so nothing here can be mistaken for an administrator's decision.
    const harness = await harnessWith(t);
    const { operationalCheckSettings: store } = harness.loadDataLayer(['operationalCheckSettings']);

    const rows = await store.listCheckSettings();
    assert.deepEqual(rows.map((r) => r.checkKey), [
      'home_time.closable_open_cycle',
      'home_time.returned_to_road',
      'identity.group_without_person',
      'identity.stale_unit_assignment',
    ]);
    for (const r of rows) assert.match(r.updatedBy, /^migration 00(27|30)/);
  });

test('granting and revoking auto-apply records who did it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCheckSettings: store } = harness.loadDataLayer(['operationalCheckSettings']);

  const on = await store.upsertCheckSettings('home_time.closable_open_cycle', {
    autoApplyEnabled: true, maxAutoPerRun: 25, updatedBy: 'admin',
  });
  assert.equal(on.autoApplyEnabled, true);
  assert.equal(on.maxAutoPerRun, 25);
  assert.equal(on.updatedBy, 'admin');

  const off = await store.upsertCheckSettings('home_time.closable_open_cycle', {
    autoApplyEnabled: false, updatedBy: 'someone_else',
  });
  assert.equal(off.autoApplyEnabled, false);
  assert.equal(off.maxAutoPerRun, 25, 'omitting the cap keeps the one already agreed');
  assert.equal(off.updatedBy, 'someone_else');

  const rows = await store.listCheckSettings();
  assert.equal(rows.filter((r) => r.checkKey === 'home_time.closable_open_cycle').length, 1, 'upsert, not insert');
  assert.equal(rows.length, 4, 'the other seeded rows are untouched');
});

test('a cap outside the permitted range is corrected, not rejected by a constraint',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { operationalCheckSettings: store } = harness.loadDataLayer(['operationalCheckSettings']);

    const high = await store.upsertCheckSettings('home_time.closable_open_cycle', {
      autoApplyEnabled: true, maxAutoPerRun: 99999,
    });
    assert.equal(high.maxAutoPerRun, 500, 'the schema CHECK would have raised something unreadable');

    const low = await store.upsertCheckSettings('identity.sync_profile_status', {
      autoApplyEnabled: true, maxAutoPerRun: 0,
    });
    assert.equal(low.maxAutoPerRun, 1);
  });

test('a granted check is what the auto-apply batch then reads', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCheckSettings: store } = harness.loadDataLayer(['operationalCheckSettings']);
  await store.upsertCheckSettings('home_time.closable_open_cycle', {
    autoApplyEnabled: true, maxAutoPerRun: 7, updatedBy: 'admin',
  });

  delete require.cache[require.resolve('../services/operations/corrections/autoApply')];
  const { loadCheckSettings } = require('../services/operations/corrections/autoApply');
  const settings = await loadCheckSettings({ query: harness.query });

  const row = settings.get('home_time.closable_open_cycle');
  assert.equal(row.auto_apply_enabled, true, 'the admin and the batch read the same row');
  assert.equal(row.mode, 'autopilot',
    'and since migration 0044 the batch acts on the MODE, so that has to be the '
    + 'same row too — granting through the older boolean still arms it');
  assert.equal(row.max_auto_per_run, 7);
});
