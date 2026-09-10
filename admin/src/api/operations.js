/**
 * Needs Attention — findings the system filed about its own data, and the
 * corrections it made or is asking permission to make.
 *
 * Two groups of calls, and the split is a real permission boundary rather than
 * a naming convention: everything above `applyFindingCorrection` reads, and is
 * available to any admin. Everything from there down changes real fleet records
 * and requires `operations.corrections.apply`, so a 403 from one of them is
 * expected and the UI must show it rather than treat it as a fault.
 *
 * A 409 from an apply or revert is also not a fault. It means the evidence moved
 * — somebody edited the row, or fixed it by hand — and the correct response is
 * to re-read the finding, not to retry.
 */
import { API_BASE, getHeaders, handleApiError } from './http';

/** Returns { findings, corrections, sweep } — the tiles plus why the page is quiet. */
export async function getOperationsSummary() {
  const res = await fetch(`${API_BASE}/operations/summary`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Returns { findings } — each with `actionable`, so the UI offers only real buttons. */
export async function getOperationsFindings({
  status = 'open', severity = null, checkKey = null, tier = null,
  includeSnoozed = false, limit = 200,
} = {}) {
  // `String(null)` is "null", which the server would happily filter on and
  // match nothing — pass 'all' to mean no filter, never a stringified null.
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);
  if (severity) params.set('severity', severity);
  if (checkKey) params.set('checkKey', checkKey);
  if (tier) params.set('tier', tier);
  if (includeSnoozed) params.set('includeSnoozed', 'true');
  const res = await fetch(`${API_BASE}/operations/findings?${params}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Returns { finding, corrections } — the drawer's whole contents. */
export async function getOperationsFinding(id) {
  const res = await fetch(`${API_BASE}/operations/findings/${id}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Returns { corrections } for the History tab. `live` null = both. */
export async function getOperationsCorrections({
  live = null, subjectType = null, subjectId = null, limit = 100, offset = 0,
} = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (live !== null) params.set('live', String(live));
  if (subjectType) params.set('subjectType', subjectType);
  if (subjectId) params.set('subjectId', subjectId);
  const res = await fetch(`${API_BASE}/operations/corrections?${params}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Returns { correction, subjectAudit }.
 *
 * `subjectAudit` is every correction event for the same SUBJECT, not just this
 * correction's: `admin_audit_log` holds no correction id to filter on.
 */
export async function getOperationsCorrection(id) {
  const res = await fetch(`${API_BASE}/operations/corrections/${id}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Every check the registry can act on, with its permission. Default deny. */
export async function getOperationsChecks() {
  const res = await fetch(`${API_BASE}/operations/checks`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** What auto-apply WOULD do, writing nothing. Readable without the apply grant. */
export async function previewAutoCorrections() {
  const res = await fetch(`${API_BASE}/operations/auto-apply/preview`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** A dismissal needs a reason; the server and the schema both refuse one without. */
export async function dismissOperationsFinding(id, reason) {
  const res = await fetch(`${API_BASE}/operations/findings/${id}/dismiss`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ reason }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Put a finding aside for `hours`, bounded at 30 days by the server. */
export async function snoozeOperationsFinding(id, hours) {
  const res = await fetch(`${API_BASE}/operations/findings/${id}/snooze`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ hours }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Re-run the checks now rather than waiting for the 15-minute sweep. */
export async function runOperationsSweep() {
  const res = await fetch(`${API_BASE}/operations/sweep`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── the person layer ────────────────────────────────────────────────────────

/** How much of the fleet has a permanent identity yet. */
export async function getIdentityCoverage() {
  const res = await fetch(`${API_BASE}/operations/identity/coverage`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** One person: every chat they have held and every truck, in time. */
export async function getPersonIdentity(personId) {
  const res = await fetch(`${API_BASE}/operations/identity/people/${personId}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.person;
}

/** What the identity backfill WOULD do. Writes nothing; readable by any admin. */
export async function previewIdentityBackfill() {
  const res = await fetch(`${API_BASE}/operations/identity/backfill/preview`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── below here changes real fleet records: operations.corrections.apply ─────

/** Populate the person layer for real, then stamp existing rows. */
export async function runIdentityBackfill() {
  const res = await fetch(`${API_BASE}/operations/identity/backfill`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Apply what a finding proposes. 409 = the evidence moved; re-read, do not retry. */
export async function applyFindingCorrection(id, reason = null) {
  const res = await fetch(`${API_BASE}/operations/findings/${id}/apply`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ reason }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Undo one. 409 = somebody edited the row since, and their edit is protected. */
export async function revertOperationsCorrection(id, reason = null) {
  const res = await fetch(`${API_BASE}/operations/corrections/${id}/revert`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ reason }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Grant or revoke auto-apply for one check. Itself a change to what software may do. */
export async function updateOperationsCheck(checkKey, { autoApplyEnabled, maxAutoPerRun = null }) {
  const res = await fetch(`${API_BASE}/operations/checks/${encodeURIComponent(checkKey)}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ autoApplyEnabled, maxAutoPerRun }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.setting;
}
