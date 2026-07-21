// Auto-reaction admin API client. Kept separate from the large api.js so that
// baselined file does not grow. Mirrors its token/error conventions.
const API_BASE = "/api";

function getHeaders() {
  const token = localStorage.getItem("token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function handleError(res) {
  let message = `HTTP Error: ${res.status}`;
  try {
    const data = await res.json();
    if (data && data.error) message = data.error;
  } catch (e) {
    // keep the default message
  }
  throw new Error(message);
}

export async function getAutoReactions() {
  const res = await fetch(`${API_BASE}/auto-reactions`, { headers: getHeaders() });
  if (!res.ok) { await handleError(res); }
  return res.json();
}

export async function createAutoReaction(payload) {
  const res = await fetch(`${API_BASE}/auto-reactions`, {
    method: "POST", headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleError(res); }
  return res.json();
}

export async function updateAutoReaction(id, patch) {
  const res = await fetch(`${API_BASE}/auto-reactions/${id}`, {
    method: "PUT", headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleError(res); }
  return res.json();
}

export async function deleteAutoReaction(id) {
  const res = await fetch(`${API_BASE}/auto-reactions/${id}`, {
    method: "DELETE", headers: getHeaders(),
  });
  if (!res.ok) { await handleError(res); }
  return res.json();
}
