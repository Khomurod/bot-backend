/**
 * Mileage bonus: progress sweeps and the notifications they produce.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

// ─── Mileage Bonus ───

export async function getMileageBonusOverview() {
  const res = await fetch(`${API_BASE}/mileage-bonus/overview?t=${Date.now()}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function runMileageBonusCheck() {
  const res = await fetch(`${API_BASE}/mileage-bonus/run`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function refreshMileageBonusProgress() {
  const res = await fetch(`${API_BASE}/mileage-bonus/refresh`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateMileageBonusDriverStatus(normalizedName, status) {
  const res = await fetch(
    `${API_BASE}/mileage-bonus/drivers/${encodeURIComponent(normalizedName)}/status`,
    {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ status }),
    }
  );
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function resendMileageBonusNotification(id) {
  const res = await fetch(`${API_BASE}/mileage-bonus/notifications/${id}/resend`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function disregardMileageBonusNotification(id) {
  const res = await fetch(`${API_BASE}/mileage-bonus/notifications/${id}/disregard`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

