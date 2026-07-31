/**
 * Client for the QBQ / SOS assessment API. Self-contained (own fetch + auth
 * header), mirroring the other admin/src/api/* submodules so the large legacy
 * api.js does not grow.
 *
 * Public endpoints send NO auth header. Real pages use /api/sos, the isolated
 * test pages use /api/sos/test — pass `isTest` to select the base; the server
 * enforces the actual data separation in SQL either way. Admin endpoints
 * attach the stored token.
 */
const BASE = "/api/sos";

function publicBase(isTest) {
  return isTest ? `${BASE}/test` : BASE;
}

async function parseOrThrow(res) {
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    if (data) Object.assign(err, data);
    throw err;
  }
  return data;
}

function authHeaders(tokenOverride) {
  const token = tokenOverride || localStorage.getItem("token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ─── Public (no auth; isTest selects the isolated test API) ───

export async function getSosMeta(isTest = false) {
  return parseOrThrow(await fetch(`${publicBase(isTest)}/meta`));
}

export async function getSosQuestionnaire(department, isTest = false) {
  return parseOrThrow(await fetch(`${publicBase(isTest)}/questionnaire?department=${encodeURIComponent(department)}`));
}

export async function submitSosAssessment(payload, isTest = false) {
  return parseOrThrow(await fetch(`${publicBase(isTest)}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
}

export async function getSosResult(token, isTest = false) {
  return parseOrThrow(await fetch(`${publicBase(isTest)}/results/${encodeURIComponent(token)}`));
}

export async function getSosSummary(isTest = false) {
  return parseOrThrow(await fetch(`${publicBase(isTest)}/summary`));
}

/**
 * Admin login used by the test-cleanup control on /answers/test. Returns the
 * short-lived JWT; the caller keeps it in memory only — it is NOT written to
 * storage by this module.
 */
export async function sosAdminLogin(username, password) {
  const data = await parseOrThrow(await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }));
  return data.token;
}

// ─── Admin (token required) ───

export async function getSosAdminStatus() {
  return parseOrThrow(await fetch(`${BASE}/admin/status`, { headers: authHeaders() }));
}

export async function setSosOpen(open, mode = "real") {
  return parseOrThrow(await fetch(`${BASE}/admin/status`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ open, mode }),
  }));
}

export async function listSosSubmissions(filters = {}) {
  const params = new URLSearchParams();
  // `team` is one of the six authoritative dispatch-team keys (see
  // services/sosAssessment/dispatchTeams.js), not a database row id.
  for (const key of ["department", "team", "pattern", "search", "mode"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const qs = params.toString();
  return parseOrThrow(await fetch(`${BASE}/admin/submissions${qs ? `?${qs}` : ""}`, { headers: authHeaders() }));
}

/** CSV needs the auth header, so fetch as a blob and trigger a download. */
export async function downloadSosCsv(mode = "real") {
  const res = await fetch(`${BASE}/admin/submissions?format=csv&mode=${encodeURIComponent(mode)}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sos-submissions-${mode}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function getSosSubmissionDetail(id) {
  return parseOrThrow(await fetch(`${BASE}/admin/submissions/${id}`, { headers: authHeaders() }));
}

export async function deleteSosSubmission(id) {
  return parseOrThrow(await fetch(`${BASE}/admin/submissions/${id}`, { method: "DELETE", headers: authHeaders() }));
}

/** Deletes ONLY test submissions (is_test = TRUE on the server). */
export async function clearSosTestData(tokenOverride) {
  return parseOrThrow(await fetch(`${BASE}/admin/clear-test`, {
    method: "POST",
    headers: authHeaders(tokenOverride),
    body: JSON.stringify({ confirm: "DELETE TEST DATA" }),
  }));
}

/** Deletes ONLY real submissions — guarded by its own confirmation phrase. */
export async function clearSosRealData() {
  return parseOrThrow(await fetch(`${BASE}/admin/clear-real`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ confirm: "DELETE ALL REAL SUBMISSIONS" }),
  }));
}
