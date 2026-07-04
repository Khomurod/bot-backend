/**
 * Fleet auth & tenancy middleware (§4, §16).
 *
 * - Tenant is derived from the verified token, never from a request body (§4.1).
 * - Permissions are resolved from the user's roles and enforced server-side;
 *   the frontend only hides controls (§16).
 */

'use strict';

const jwt = require('jsonwebtoken');
const { DB, PERMISSIONS } = require('./store');
const { apiError } = require('./domain');
const { isReal, REAL_TENANT, REAL_COMPANY } = require('./config');

// Demo-mode secret (self-contained). In real mode we federate with the existing
// admin panel's JWT_SECRET (decision ③c) and fail closed if it is unset.
const FLEET_JWT_SECRET = process.env.FLEET_JWT_SECRET || process.env.JWT_SECRET || 'fleet-dev-secret-change-me';
const TOKEN_TTL = '12h';

function realSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required in FLEETVIEW_DATA_MODE=real');
  return s;
}

// Real-mode identity: a single Wenze tenant + Admin (all permissions) derived
// from the verified existing-admin token. No demo users, no demo1234.
function realIdentity(username) {
  return {
    id: `admin:${username}`, display_name: username, email: username,
    tenant_id: REAL_TENANT.id, company_ids: [REAL_COMPANY.id],
    default_company_id: REAL_COMPANY.id, role_ids: [], status: 'active',
  };
}

function permissionsForUser(user) {
  const set = new Set();
  (user.role_ids || []).forEach((rid) => {
    const role = DB.roles.find((r) => r.id === rid && r.tenant_id === user.tenant_id);
    if (role) role.permissions.forEach((p) => set.add(p));
  });
  return [...set];
}

function issueToken(user, activeCompanyId) {
  return jwt.sign(
    { sub: user.id, tid: user.tenant_id, cid: activeCompanyId || user.default_company_id },
    FLEET_JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

// Demo login (synthetic users). Returns null on failure.
function login(email, password) {
  const user = DB.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || user.password !== password || user.status !== 'active') return null;
  const token = issueToken(user);
  return { token, user, activeCompanyId: user.default_company_id };
}

// Real login: federate with the existing `admins` table (bcrypt). Accepts the
// `email` field as the admin username. Issues a JWT_SECRET-signed token whose
// shape ({id, username}) is compatible with the existing /admin panel (③c).
async function loginReal(username, password) {
  const bcrypt = require('bcryptjs');
  const db = require('../../database/db');
  const admin = await db.getAdminByUsername(String(username || '').trim());
  if (!admin) return null;
  const ok = await bcrypt.compare(String(password || ''), admin.password_hash);
  if (!ok) return null;
  const token = jwt.sign({ id: admin.id, username: admin.username }, realSecret(), { algorithm: 'HS256', expiresIn: TOKEN_TTL });
  return { token, user: realIdentity(admin.username), activeCompanyId: REAL_COMPANY.id };
}

// Attaches req.auth = { user, tenantId, companyId, permissions }
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return apiError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');

  if (isReal()) {
    // Federated: verify against the existing admin panel's JWT_SECRET (③c).
    let rp;
    try { rp = jwt.verify(token, realSecret(), { algorithms: ['HS256'] }); } catch (e) {
      return apiError(res, 401, 'UNAUTHENTICATED', 'Session expired or invalid.');
    }
    if (!rp || !rp.username) return apiError(res, 401, 'UNAUTHENTICATED', 'Invalid token.');
    req.auth = {
      user: realIdentity(rp.username), tenantId: REAL_TENANT.id, companyId: REAL_COMPANY.id,
      permissions: [...PERMISSIONS], // single Admin role in real mode
    };
    return next();
  }

  let payload;
  try {
    payload = jwt.verify(token, FLEET_JWT_SECRET);
  } catch (e) {
    return apiError(res, 401, 'UNAUTHENTICATED', 'Session expired or invalid.');
  }
  const user = DB.users.find((u) => u.id === payload.sub && u.tenant_id === payload.tid);
  if (!user) return apiError(res, 401, 'UNAUTHENTICATED', 'User not found.');

  // Company context: header override must be a company the user can access (§4.3).
  const requestedCompany = req.headers['x-company-id'] || payload.cid;
  const companyId = user.company_ids.includes(requestedCompany) ? requestedCompany : user.default_company_id;

  req.auth = {
    user,
    tenantId: user.tenant_id,
    companyId,
    permissions: permissionsForUser(user),
  };
  next();
}

// Permission gate factory (§16). Backend is authoritative.
function requirePermission(...needed) {
  return (req, res, next) => {
    const have = new Set(req.auth.permissions);
    const ok = needed.some((p) => have.has(p));
    if (!ok) {
      return apiError(res, 403, 'FORBIDDEN', `Missing permission: ${needed.join(' or ')}.`);
    }
    next();
  };
}

// Tenant-scoped view of any DB collection (§4). Never leak cross-tenant rows.
function scoped(req, collection) {
  const tid = req.auth.tenantId;
  return DB[collection].filter((row) => row.tenant_id === tid);
}

// Audit record for every mutation (§4.7, §15). Demo → in-memory; real → Postgres.
function audit(req, action, targetType, targetId, before, after, reason) {
  const row = {
    tenant_id: req.auth.tenantId, actor: req.auth.user.id, action,
    target_type: targetType, target_id: targetId, before: before || null,
    after: after || null, reason: reason || null,
    correlation_id: `cid_${Date.now().toString(36)}`, timestamp: new Date().toISOString(),
  };
  if (isReal()) {
    // Fire-and-forget persistence; never block or fail the request on audit I/O.
    require('./realDb').insertAudit(row).catch((e) => console.error('[FLEET] audit persist failed:', e.message));
    return;
  }
  DB.auditLog.push({ id: `aud_${DB.auditLog.length + 1}`, ...row });
}

module.exports = { login, loginReal, issueToken, authenticate, requirePermission, scoped, audit, permissionsForUser, FLEET_JWT_SECRET };
