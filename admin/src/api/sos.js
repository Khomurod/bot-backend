/**
 * Client for the QBQ / SOS assessment API. Self-contained (own fetch + auth
 * header), mirroring the other admin/src/api/* submodules so the large legacy
 * api.js does not grow.
 *
 * Public endpoints (used by /questions and /answers) send NO auth header.
 * Admin endpoints attach the stored token.
 */
const BASE = "/api/sos";

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

function authHeaders() {
  const token = localStorage.getItem("token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ─── Public (no auth) ───

export async function getSosMeta() {
  return parseOrThrow(await fetch(`${BASE}/meta`));
}

export async function getSosQuestionnaire(department) {
  return parseOrThrow(await fetch(`${BASE}/questionnaire?department=${encodeURIComponent(department)}`));
}

export async function submitSosAssessment(payload) {
  return parseOrThrow(await fetch(`${BASE}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
}

export async function getSosResult(token) {
  return parseOrThrow(await fetch(`${BASE}/results/${encodeURIComponent(token)}`));
}

export async function getSosSummary() {
  return parseOrThrow(await fetch(`${BASE}/summary`));
}

// ─── Admin (token required) ───

export async function getSosAdminStatus() {
  return parseOrThrow(await fetch(`${BASE}/admin/status`, { headers: authHeaders() }));
}

export async function setSosOpen(open) {
  return parseOrThrow(await fetch(`${BASE}/admin/status`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ open }),
  }));
}

export async function listSosSubmissions(filters = {}) {
  const params = new URLSearchParams();
  for (const key of ["department", "teamId", "pattern", "search"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const qs = params.toString();
  return parseOrThrow(await fetch(`${BASE}/admin/submissions${qs ? `?${qs}` : ""}`, { headers: authHeaders() }));
}

export function sosCsvUrl() {
  return `${BASE}/admin/submissions?format=csv`;
}

/** CSV needs the auth header, so fetch as a blob and trigger a download. */
export async function downloadSosCsv() {
  const res = await fetch(sosCsvUrl(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sos-submissions.csv";
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

export async function clearSosSubmissions() {
  return parseOrThrow(await fetch(`${BASE}/admin/clear`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ confirm: "DELETE ALL" }),
  }));
}
