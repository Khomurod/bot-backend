'use strict';

const { query, pool } = require('./pool');
const { insertTrailerAudit } = require('./trailerAudit');
const { generateCustomRoleKey, isReservedRoleKey } = require('../services/rbac/roleKeys');

async function auditRbac(client, actorId, action, entityType, entityId, oldValues, newValues) {
  const actor = actorId ? await getAdminAuthorization(actorId, client) : null;
  await insertTrailerAudit({ adminId: actorId, roleKeys: actor?.role_keys || [], action,
    entityType, entityId, oldValues, newValues }, client);
}

function publicAdmin(row) {
  if (!row) return null;
  const { password_hash: _passwordHash, ...safe } = row;
  return safe;
}

async function getAdminAuthorization(adminId, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `SELECT a.id, a.username, a.active, a.last_login_at, a.created_at,
            a.updated_at, a.auth_version,
            COALESCE(array_agg(DISTINCT r.system_key) FILTER (WHERE r.system_key IS NOT NULL), '{}') AS role_keys,
            COALESCE(array_agg(DISTINCT p.permission_key) FILTER (WHERE p.permission_key IS NOT NULL), '{}') AS permissions
       FROM admins a
       LEFT JOIN admin_user_roles aur ON aur.admin_id = a.id
       LEFT JOIN roles r ON r.id = aur.role_id AND r.active = TRUE
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE a.id = $1
      GROUP BY a.id`,
    [adminId],
  );
  return publicAdmin(res.rows[0]);
}

async function markAdminLogin(adminId) {
  await query('UPDATE admins SET last_login_at = NOW() WHERE id = $1', [adminId]);
}

async function changeOwnPassword(adminId, passwordHash) {
  const res = await query(
    `UPDATE admins
        SET password_hash = $2, auth_version = auth_version + 1, updated_at = NOW()
      WHERE id = $1 AND active = TRUE
      RETURNING id, username, active, auth_version, updated_at`,
    [adminId, passwordHash],
  );
  return res.rows[0] || null;
}

async function listAdminUsers() {
  const res = await query(
    `SELECT a.id, a.username, a.active, a.last_login_at, a.created_at, a.updated_at,
            a.created_by_admin_id, a.updated_by_admin_id,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
              'id', r.id, 'system_key', r.system_key, 'display_name', r.display_name
            )) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS roles
       FROM admins a
       LEFT JOIN admin_user_roles aur ON aur.admin_id = a.id
       LEFT JOIN roles r ON r.id = aur.role_id
      GROUP BY a.id
      ORDER BY lower(a.username)`,
  );
  return res.rows;
}

async function listRolesAndPermissions() {
  const [roles, permissions] = await Promise.all([
    query(
      `SELECT r.id, r.system_key, r.display_name, r.description, r.active,
              COALESCE(array_agg(p.permission_key ORDER BY p.permission_key)
                FILTER (WHERE p.permission_key IS NOT NULL), '{}') AS permissions
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        GROUP BY r.id ORDER BY r.display_name`,
    ),
    query('SELECT id, permission_key, description FROM permissions ORDER BY permission_key'),
  ]);
  return { roles: roles.rows, permissions: permissions.rows };
}

async function createAdminUser({ username, passwordHash, roleIds, actorId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO admins (username, password_hash, active, created_by_admin_id, updated_by_admin_id)
       VALUES ($1, $2, TRUE, $3, $3)
       RETURNING id, username, active, created_at, auth_version`,
      [String(username).trim(), passwordHash, actorId || null],
    );
    for (const roleId of [...new Set(roleIds.map(Number))]) {
      await client.query(
        `INSERT INTO admin_user_roles (admin_id, role_id, assigned_by_admin_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [created.rows[0].id, roleId, actorId || null],
      );
    }
    await auditRbac(client, actorId, 'admin.create', 'admin', created.rows[0].id, null, created.rows[0]);
    await client.query('COMMIT');
    return getAdminAuthorization(created.rows[0].id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function countActiveSuperAdmins(client) {
  const res = await client.query(
    `SELECT COUNT(DISTINCT a.id)::int AS count
       FROM admins a
       JOIN admin_user_roles aur ON aur.admin_id = a.id
       JOIN roles r ON r.id = aur.role_id
      WHERE a.active = TRUE AND r.system_key = 'super_admin'`,
  );
  return res.rows[0]?.count || 0;
}

async function updateAdminUser(adminId, { username, active, roleIds, passwordHash, actorId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT id, username, active FROM admins WHERE id = $1 FOR UPDATE', [adminId]);
    if (!before.rows[0]) { await client.query('ROLLBACK'); return null; }
    const existingRoles = await client.query(
      `SELECT r.system_key FROM admin_user_roles aur JOIN roles r ON r.id = aur.role_id WHERE aur.admin_id = $1`,
      [adminId],
    );
    const removingLastSuper = existingRoles.rows.some((r) => r.system_key === 'super_admin')
      && (active === false || Array.isArray(roleIds));
    if (removingLastSuper && await countActiveSuperAdmins(client) <= 1) {
      let retainsSuper = active !== false;
      if (Array.isArray(roleIds)) {
        const selected = await client.query('SELECT system_key FROM roles WHERE id = ANY($1::int[])', [roleIds.map(Number)]);
        retainsSuper = retainsSuper && selected.rows.some((r) => r.system_key === 'super_admin');
      }
      if (!retainsSuper) {
        const error = new Error('The last active super administrator cannot be disabled or demoted.');
        error.status = 409;
        throw error;
      }
    }
    const sets = ['updated_by_admin_id = $2', 'updated_at = NOW()'];
    const params = [adminId, actorId || null];
    if (username != null) { params.push(String(username).trim()); sets.push(`username = $${params.length}`); }
    if (active != null) { params.push(Boolean(active)); sets.push(`active = $${params.length}`); }
    if (passwordHash) { params.push(passwordHash); sets.push(`password_hash = $${params.length}`); }
    if (passwordHash || active === false) sets.push('auth_version = auth_version + 1');
    await client.query(`UPDATE admins SET ${sets.join(', ')} WHERE id = $1`, params);
    if (Array.isArray(roleIds)) {
      await client.query('DELETE FROM admin_user_roles WHERE admin_id = $1', [adminId]);
      for (const roleId of [...new Set(roleIds.map(Number))]) {
        await client.query(
          'INSERT INTO admin_user_roles (admin_id, role_id, assigned_by_admin_id) VALUES ($1,$2,$3)',
          [adminId, roleId, actorId || null],
        );
      }
      await client.query('UPDATE admins SET auth_version = auth_version + 1 WHERE id = $1', [adminId]);
    }
    const after = await getAdminAuthorization(adminId, client);
    await auditRbac(client, actorId, 'admin.update', 'admin', adminId, before.rows[0], after);
    await client.query('COMMIT');
    return getAdminAuthorization(adminId);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function createRole({ displayName, description, permissionKeys, actorId, systemKey }) {
  const name = String(displayName || '').trim();
  if (!name) {
    throw Object.assign(new Error('Role name is required.'), { status: 400, code: 'INVALID_ROLE_NAME' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Custom roles get a stable, unique `custom_*` system key generated from the
    // name. A caller-supplied key must not be reserved and must be unique. Both
    // are checked against the current key set inside this transaction.
    const existing = await client.query('SELECT system_key FROM roles WHERE system_key IS NOT NULL');
    const existingKeys = existing.rows.map((r) => r.system_key);
    let key;
    if (systemKey) {
      key = String(systemKey).trim().toLowerCase();
      if (isReservedRoleKey(key)) {
        throw Object.assign(new Error('That role key is reserved for the system.'), { status: 409, code: 'ROLE_KEY_RESERVED' });
      }
      if (existingKeys.some((k) => String(k).toLowerCase() === key)) {
        throw Object.assign(new Error('A role with that key already exists.'), { status: 409, code: 'ROLE_KEY_TAKEN' });
      }
    } else {
      key = generateCustomRoleKey(name, existingKeys);
    }
    const role = await client.query(
      `INSERT INTO roles (system_key, display_name, description, created_by_admin_id, updated_by_admin_id)
       VALUES ($1,$2,$3,$4,$4) RETURNING *`,
      [key, name, description || null, actorId || null],
    );
    await replaceRolePermissions(client, role.rows[0].id, permissionKeys, actorId);
    await auditRbac(client, actorId, 'role.create', 'role', role.rows[0].id, null,
      { ...role.rows[0], permissions: permissionKeys });
    await client.query('COMMIT');
    return role.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function replaceRolePermissions(client, roleId, permissionKeys, actorId) {
  await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
  if (!permissionKeys.length) return;
  await client.query(
    `INSERT INTO role_permissions (role_id, permission_id, granted_by_admin_id)
     SELECT $1, id, $3 FROM permissions WHERE permission_key = ANY($2::text[])`,
    [roleId, permissionKeys, actorId || null],
  );
}

async function updateRole(roleId, { displayName, description, active, permissionKeys, actorId, version }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [roleId]);
    if (!current.rows[0]) { await client.query('ROLLBACK'); return null; }
    // Optimistic locking: a stale version means someone else edited the role.
    if (version !== undefined && version !== null
        && Number(current.rows[0].version) !== Number(version)) {
      throw Object.assign(
        new Error('This role changed while you were editing it. Review the latest version before saving again.'),
        { status: 409, code: 'VERSION_CONFLICT', currentVersion: current.rows[0].version },
      );
    }
    if (current.rows[0].system_key === 'super_admin' && (active === false
      || (Array.isArray(permissionKeys) && !permissionKeys.includes('admin.full_access')))) {
      const error = new Error('The system super administrator role cannot be disabled or lose full access.');
      error.status = 409;
      throw error;
    }
    await client.query(
      `UPDATE roles SET display_name = COALESCE($2, display_name),
         description = COALESCE($3, description), active = COALESCE($4, active),
         updated_by_admin_id = $5, updated_at = NOW(), version = version + 1 WHERE id = $1`,
      [roleId, displayName || null, description ?? null, active ?? null, actorId || null],
    );
    if (Array.isArray(permissionKeys)) await replaceRolePermissions(client, roleId, permissionKeys, actorId);
    await client.query(
      `UPDATE admins SET auth_version = auth_version + 1
       WHERE id IN (SELECT admin_id FROM admin_user_roles WHERE role_id = $1)`,
      [roleId],
    );
    await auditRbac(client, actorId, 'role.update', 'role', roleId, current.rows[0],
      { displayName, description, active, permissions: permissionKeys });
    await client.query('COMMIT');
    return (await listRolesAndPermissions()).roles.find((r) => Number(r.id) === Number(roleId)) || null;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw error;
  } finally { client.release(); }
}

module.exports = {
  publicAdmin,
  getAdminAuthorization,
  markAdminLogin,
  changeOwnPassword,
  listAdminUsers,
  listRolesAndPermissions,
  createAdminUser,
  updateAdminUser,
  createRole,
  updateRole,
};
