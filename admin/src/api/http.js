/**
 * Shared HTTP plumbing for the admin API client.
 *
 * Every domain module imports from here, so the base URL, the bearer-token
 * headers, and the error-unwrapping behaviour are defined exactly once.
 */

export async function handleApiError(res) {
  let errorMessage = `HTTP Error: ${res.status}`;
  try {
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const errData = await res.json();
      const base = errData.error || errorMessage;
      errorMessage = errData.detail ? `${base} (${errData.detail})` : base;
    } else {
      const textData = await res.text();
      errorMessage = textData.length < 200 ? textData : errorMessage;
    }
  } catch (e) {
    // Fallback if parsing fails entirely
  }
  throw new Error(errorMessage);
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
