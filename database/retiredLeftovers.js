'use strict';

/**
 * Retired-feature leftovers: what a removed feature left behind in the
 * database, and the operations that clear it.
 *
 * WHY THIS EXISTS. Removing a feature from the code does not remove its tables
 * or its permission rows. Following the FleetView precedent, the removals left
 * every table in place so no history was destroyed by a deploy — but that
 * leaves a database carrying tables nothing reads, role rows nothing grants,
 * and admin accounts whose only roles are for a department that no longer
 * exists. This module is what an administrator uses to finish the job, on
 * purpose, from Settings → Retired feature leftovers.
 *
 * THREE SAFETY PROPERTIES, none of them optional:
 *
 *  1. THE TABLE LIST IS HARD-CODED HERE. A table name never travels from an
 *     HTTP request into SQL. The caller selects GROUPS; a name that is not in
 *     `RETIRED_GROUPS` below cannot be dropped through this path at all, so no
 *     request — malformed, malicious or mistaken — can reach a surviving table.
 *  2. NO `CASCADE`. Drops are attempted repeatedly, in passes, dropping
 *     whatever has no remaining dependents until a pass makes no progress.
 *     That resolves the foreign-key order without a hand-maintained list, and
 *     — this is the point — a table still referenced by something OUTSIDE the
 *     list fails to drop and is REPORTED, instead of quietly taking the
 *     referencing rows with it.
 *  3. CONFIRMATION IS THE CALLER'S JOB and it is checked at the route. This
 *     module performs what it is told; the route will not tell it to drop
 *     anything without an exact typed confirmation phrase.
 *
 * Config purging (roles, permissions, grants, account deactivation) is separate
 * from table dropping, because one is reversible bookkeeping and the other
 * destroys history.
 */

const { pool, query } = require('./pool');
const { insertAdminAudit } = require('./adminAudit');

/**
 * Every table a removed feature left behind, grouped by the feature that
 * created it. ONLY these names can ever be dropped through this module.
 */
const RETIRED_GROUPS = Object.freeze({
  trailer: Object.freeze({
    label: 'Trailer Department and Trailer Tracking',
    removedAt: '2026-09',
    note: 'Rental agreements, inspections, invoices, payments and the trailer '
      + 'master list. Dropping these permanently destroys rental and payment history.',
    tables: Object.freeze([
      'trailer_aliases',
      'trailer_audit_log',
      'trailer_company_credit_applications',
      'trailer_company_credits',
      'trailer_current_status',
      'trailer_events',
      'trailer_import_batches',
      'trailer_import_rows',
      'trailer_inspections',
      'trailer_invoice_adjustments',
      'trailer_invoice_lines',
      'trailer_invoices',
      'trailer_master_reconciliation_log',
      'trailer_media',
      'trailer_media_blobs',
      'trailer_notification_jobs',
      'trailer_payment_reversals',
      'trailer_payments',
      'trailer_pending_instructions',
      'trailer_reminder_history',
      'trailer_rental_agreements',
      'trailer_rental_amendments',
      'trailer_rental_items',
      'trailer_rental_movements',
      'trailer_rentals',
      'trailer_renter_companies',
      'trailer_settings',
      'trailer_unmatched_mentions',
      'trailers',
    ]),
  }),
  qbq_sos: Object.freeze({
    label: 'QBQ / SOS assessment and presentation',
    removedAt: '2026-09',
    note: 'Questionnaire submissions, answers and the saved presentation edits.',
    tables: Object.freeze([
      'sos_answers',
      'sos_submissions',
      'sos_settings',
      'qbq_presentation_edits',
    ]),
  }),
  fleetview: Object.freeze({
    label: 'FleetView Operations Platform',
    removedAt: '2026-07',
    note: 'Created lazily at runtime by code that no longer exists, so these '
      + 'were never part of the baseline schema and nothing has written to them since.',
    tables: Object.freeze([
      'fleet_audit_log',
      'fleet_settings',
      'fleet_snapshots',
      'fleet_sync_log',
      'fleet_sync_runs',
      'fleet_task_activity',
      'fleet_task_comments',
      'fleet_tasks',
      'fleet_unit_snapshots',
    ]),
  }),
  earlier: Object.freeze({
    label: 'Earlier retired features',
    removedAt: 'various',
    note: 'The driver check-in/check-out monitor and the employee voting polls. '
      + 'Listed for completeness — review before selecting.',
    tables: Object.freeze([
      'driver_location_checkins',
      'driver_location_monitors',
      'employee_votes',
      'employee_votes_options',
      'employee_votes_polls',
    ]),
  }),
});

/** Role system_keys a removed feature seeded. Hard-coded, same reason. */
const RETIRED_ROLE_KEYS = Object.freeze([
  'trailer_manager',
  'trailer_employee',
  'trailer_accounting',
  'trailer_viewer',
]);

/**
 * Permission-key prefixes a removed feature seeded. `admin.full_access`,
 * `users.manage` and `roles.manage` are company-wide and are NOT here.
 */
const RETIRED_PERMISSION_PREFIXES = Object.freeze(['trailer_', 'trailers.']);

const GROUP_KEYS = Object.freeze(Object.keys(RETIRED_GROUPS));

/**
 * A plain lowercase identifier. Every table name here comes from the frozen
 * lists above, never from a request — but these names are interpolated into
 * `DROP TABLE`, so the shape is checked at the interpolation site too. Defence
 * in depth against a future edit to the lists, not against a caller.
 */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function assertSafeIdentifier(name) {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to interpolate an unsafe table name: ${JSON.stringify(name)}`);
  }
  return name;
}

function isKnownGroup(key) {
  return Object.prototype.hasOwnProperty.call(RETIRED_GROUPS, key);
}

/** The allow-listed tables for a set of group keys, de-duplicated. */
function tablesForGroups(groupKeys) {
  const out = [];
  for (const key of groupKeys) {
    if (!isKnownGroup(key)) throw Object.assign(new Error(`Unknown leftover group: ${key}`), { status: 400 });
    for (const table of RETIRED_GROUPS[key].tables) if (!out.includes(table)) out.push(table);
  }
  return out;
}

/** Which of the given tables actually exist, with their row counts. */
async function inspectTables(tableNames) {
  const present = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [tableNames],
  );
  const existing = new Set(present.rows.map((r) => r.table_name));
  const out = [];
  for (const name of tableNames) {
    if (!existing.has(name)) {
      out.push({ table: name, present: false, rows: null });
      continue;
    }
    // Interpolated from the hard-coded allow-list only, and re-checked for
    // shape. A count() is exact and these tables are idle.
    const count = await query(`SELECT COUNT(*)::bigint AS n FROM "${assertSafeIdentifier(name)}"`);
    out.push({ table: name, present: true, rows: Number(count.rows[0].n) });
  }
  return out;
}

/**
 * The full inventory: per group, which tables are still there and how many rows
 * they hold, plus the RBAC rows and the accounts that only hold retired roles.
 */
async function getLeftoverInventory() {
  const groups = [];
  for (const key of GROUP_KEYS) {
    const meta = RETIRED_GROUPS[key];
    const tables = await inspectTables([...meta.tables]);
    groups.push({
      key,
      label: meta.label,
      removed_at: meta.removedAt,
      note: meta.note,
      tables,
      tables_present: tables.filter((t) => t.present).length,
      total_rows: tables.reduce((sum, t) => sum + (t.rows || 0), 0),
    });
  }

  const roles = await query(
    `SELECT r.id, r.system_key, r.display_name,
            (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_grants,
            (SELECT COUNT(*)::int FROM admin_user_roles aur WHERE aur.role_id = r.id) AS assigned_admins
       FROM roles r WHERE r.system_key = ANY($1::text[]) ORDER BY r.system_key`,
    [[...RETIRED_ROLE_KEYS]],
  );

  const permissions = await query(
    `SELECT p.permission_key,
            (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.permission_id = p.id) AS role_grants
       FROM permissions p
      WHERE ${RETIRED_PERMISSION_PREFIXES.map((_, i) => `p.permission_key LIKE $${i + 1}`).join(' OR ')}
      ORDER BY p.permission_key`,
    RETIRED_PERMISSION_PREFIXES.map((prefix) => `${prefix}%`),
  );

  const accounts = await retiredOnlyAccounts();

  return {
    groups,
    rbac: {
      roles: roles.rows,
      permissions: permissions.rows,
      accounts,
    },
  };
}

/**
 * Admin accounts whose ONLY roles are retired roles — they can still sign in
 * and have nothing they can open. An account with any surviving role is left
 * alone; so is one with no roles at all, which is not this feature's doing.
 */
async function retiredOnlyAccounts() {
  const res = await query(
    `SELECT a.id, a.username, a.active,
            ARRAY_AGG(r.system_key ORDER BY r.system_key) AS role_keys
       FROM admins a
       JOIN admin_user_roles aur ON aur.admin_id = a.id
       JOIN roles r ON r.id = aur.role_id
      GROUP BY a.id, a.username, a.active
     HAVING BOOL_AND(r.system_key = ANY($1::text[]))
      ORDER BY a.username`,
    [[...RETIRED_ROLE_KEYS]],
  );
  return res.rows;
}

/**
 * Clear the RBAC leftovers: deactivate accounts that hold only retired roles,
 * then delete the retired roles and permissions. `role_permissions` and
 * `admin_user_roles` cascade from those deletes by their own foreign keys.
 *
 * NOT destructive to business data, and reversible by re-granting a role.
 * Accounts are DEACTIVATED rather than deleted so the audit trail keeps
 * resolving who did what.
 */
async function purgeRetiredRbac({ actorId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const accounts = await client.query(
      `UPDATE admins SET active = FALSE, auth_version = auth_version + 1, updated_at = NOW()
        WHERE active = TRUE AND id IN (
          SELECT a.id FROM admins a
            JOIN admin_user_roles aur ON aur.admin_id = a.id
            JOIN roles r ON r.id = aur.role_id
           GROUP BY a.id
          HAVING BOOL_AND(r.system_key = ANY($1::text[]))
        )
        RETURNING id, username`,
      [[...RETIRED_ROLE_KEYS]],
    );

    const roles = await client.query(
      'DELETE FROM roles WHERE system_key = ANY($1::text[]) RETURNING system_key',
      [[...RETIRED_ROLE_KEYS]],
    );

    const permissions = await client.query(
      `DELETE FROM permissions
        WHERE ${RETIRED_PERMISSION_PREFIXES.map((_, i) => `permission_key LIKE $${i + 1}`).join(' OR ')}
        RETURNING permission_key`,
      RETIRED_PERMISSION_PREFIXES.map((prefix) => `${prefix}%`),
    );

    const result = {
      deactivated_accounts: accounts.rows,
      deleted_roles: roles.rows.map((r) => r.system_key),
      deleted_permissions: permissions.rows.map((r) => r.permission_key),
    };

    await insertAdminAudit({
      adminId: actorId,
      action: 'retired_leftovers.purge_config',
      entityType: 'rbac',
      entityId: 'retired',
      newValues: result,
    }, client);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Drop the tables of the selected groups.
 *
 * Passes, not CASCADE: each pass tries every remaining table on its own
 * SAVEPOINT, so a table that still has a dependent fails alone and the rest of
 * the pass continues. When a pass drops nothing, whatever is left cannot be
 * dropped without cascading — which is exactly the case that must be reported
 * rather than forced.
 */
async function dropRetiredTables({ groupKeys, actorId = null } = {}) {
  const tables = tablesForGroups(groupKeys);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const present = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [tables],
    );
    let remaining = present.rows.map((r) => r.table_name);
    const absent = tables.filter((t) => !remaining.includes(t));
    const dropped = [];
    const blocked = [];

    while (remaining.length) {
      const stillRemaining = [];
      for (const name of remaining) {
        await client.query('SAVEPOINT drop_one');
        try {
          // Interpolated from the hard-coded allow-list only, and re-checked
          // for shape — see the module header. No CASCADE: a dependent outside
          // the list must fail here rather than be taken with it.
          await client.query(`DROP TABLE "${assertSafeIdentifier(name)}"`);
          await client.query('RELEASE SAVEPOINT drop_one');
          dropped.push(name);
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT drop_one');
          await client.query('RELEASE SAVEPOINT drop_one');
          stillRemaining.push({ table: name, reason: err.message });
        }
      }
      if (stillRemaining.length === remaining.length) {
        blocked.push(...stillRemaining);
        break;
      }
      remaining = stillRemaining.map((entry) => entry.table);
    }

    const result = {
      groups: [...groupKeys],
      dropped: dropped.sort(),
      already_absent: absent.sort(),
      blocked,
    };

    await insertAdminAudit({
      adminId: actorId,
      action: 'retired_leftovers.drop_tables',
      entityType: 'schema',
      entityId: groupKeys.join(','),
      newValues: result,
    }, client);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  RETIRED_GROUPS,
  RETIRED_ROLE_KEYS,
  RETIRED_PERMISSION_PREFIXES,
  GROUP_KEYS,
  isKnownGroup,
  assertSafeIdentifier,
  tablesForGroups,
  getLeftoverInventory,
  retiredOnlyAccounts,
  purgeRetiredRbac,
  dropRetiredTables,
};
