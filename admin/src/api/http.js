/**
 * Shared HTTP plumbing for the admin API client.
 *
 * Every domain module imports from here, so the base URL, the bearer-token
 * headers, and the error-unwrapping behaviour are defined exactly once.
 */
import { ApiError } from './apiError';

/**
 * Turn a failed response into a thrown ApiError.
 *
 * THE ONE FUNNEL: every `if (!res.ok)` in every domain module comes through
 * here, so this is where a failure stops being an opaque string. The message is
 * built exactly as before (callers show `e.message` verbatim); the status, the
 * server's `code`, and whether the body was HTML ride along so the UI can say
 * WHICH kind of failure it was — expired session, missing permission, Supabase
 * outage or quota, or an outdated browser tab.
 */
export async function handleApiError(res) {
  let errorMessage = `HTTP Error: ${res.status}`;
  let code = null;
  let detail = null;
  let htmlBody = false;
  try {
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const errData = await res.json();
      const base = errData.error || errorMessage;
      code = errData.code || null;
      detail = errData.detail || null;
      errorMessage = errData.detail ? `${base} (${errData.detail})` : base;
    } else {
      htmlBody = Boolean(contentType && contentType.includes("text/html"));
      const textData = await res.text();
      // An HTML body is the SPA index page, not an error message: showing its
      // markup to an admin explains nothing.
      if (!htmlBody) errorMessage = textData.length < 200 ? textData : errorMessage;
    }
  } catch (e) {
    // Fallback if parsing fails entirely
  }
  throw new ApiError(errorMessage, { status: res.status, code, detail, url: res.url, htmlBody });
}

export const API_BASE = '/api';
export function getHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function getAuthHeader() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Attach the active/inactive audience filter to a send payload.
 *
 * Only meaningful when the audience is "all" or "language_groups" — an
 * explicit list of driver ids already names its own recipients, so adding the
 * filter there could silently drop groups the admin picked on purpose.
 *
 * Shared by broadcast.js, scheduled.js and groups.js. It lived unexported in
 * groups.js, so the two other callers referenced a name that was not in their
 * module scope: every broadcast send with an audience filter threw
 * "appendTargetActiveFilter is not defined" before it reached the network.
 */
export function appendTargetActiveFilter(body, targetType, targetActiveFilter) {
  if (targetType === 'all' || targetType === 'language_groups') {
    body.target_active_filter = targetActiveFilter || 'active';
  }
  return body;
}
