/**
 * FleetView runtime mode.
 *
 * FLEETVIEW_DATA_MODE:
 *   'demo' (default) — self-contained synthetic in-memory store. Production is
 *                      unchanged until this is explicitly set to 'real'.
 *   'real'           — federated auth (existing admins) + live read-only data
 *                      from the existing DataTruck/Samsara services and Postgres.
 *
 * The app NEVER silently falls back to demo data in real mode (§Phase 8): if a
 * real source is unavailable, the API returns an honest empty/stale/error state.
 */

'use strict';

function dataMode() {
  const explicit = String(process.env.FLEETVIEW_DATA_MODE || '').trim().toLowerCase();
  if (explicit === 'real' || explicit === 'demo') return explicit;
  // No explicit setting: production deployments run REAL (no new Render env var
  // needed — Render always sets RENDER=true); local dev and tests default to demo.
  if (process.env.RENDER || process.env.NODE_ENV === 'production') return 'real';
  return 'demo';
}
function isReal() { return dataMode() === 'real'; }
function isDemo() { return dataMode() === 'demo'; }

// The single real tenant/company (decision ①a). tenant_id plumbing is retained
// so multi-company remains possible later, but only Wenze is populated.
const REAL_TENANT = { id: 'tnt_wenze', name: 'Wenze Investments', slug: 'wenze' };
const REAL_COMPANY = { id: 'cmp_wenze', name: 'Wenze', tenant_id: REAL_TENANT.id };

module.exports = { dataMode, isReal, isDemo, REAL_TENANT, REAL_COMPANY };
