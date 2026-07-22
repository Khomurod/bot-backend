/**
 * Admin client for the Driver Home Time DECISION endpoint. Self-contained (its own
 * auth header + fetch), mirroring the other admin/src/api/* submodules, so the
 * large legacy api.js does not have to grow.
 *
 * The server runs the SAME workflow as the Telegram approval buttons: it records
 * which admin decided and when, stops reminders, settles the Telegram card, and —
 * for an approval — sends the employee-group announcement.
 */
const BASE = "/api/home-time";

function authHeaders() {
  const token = localStorage.getItem("token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Approve or decline a pending home-time request.
 * @param {number} id
 * @param {"approve"|"decline"} decision
 * @returns {Promise<{request: object}>}
 * @throws {Error} with the server's message (e.g. already decided, invalid dates)
 */
export async function decideHomeTimeRequest(id, decision) {
  const res = await fetch(`${BASE}/requests/${id}/decision`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      message = (await res.json()).error || message;
    } catch (_) {
      /* keep the default */
    }
    throw new Error(message);
  }
  return res.json();
}
