/**
 * Fuel Monitor: active drivers, their group members, and reminders.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

/** Fuel Monitor: active company drivers + their saved Telegram usernames. */
export async function getFuelMonitor() {
  const res = await fetch(`${API_BASE}/fuel-monitor`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data?.drivers) ? data.drivers : [];
}

/**
 * Members the bot has seen interact in a group, for the Driver Groups
 * "Driver Username" dropdown. Telegram bots cannot enumerate a group's full
 * member list, so silent members won't appear until they interact.
 */
export async function getGroupMembers(groupId) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/members`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data?.members) ? data.members : [];
}

/** Manually send the fuel reminder to a driver's group now (auto reminder still runs). */
export async function sendFuelReminder(groupId) {
  const res = await fetch(`${API_BASE}/fuel-monitor/${groupId}/send-reminder`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Re-scan the fuel message inbox; pick up any pending fuel messages from the last 24 h. */
export async function refreshFuelMonitor() {
  const res = await fetch(`${API_BASE}/fuel-monitor/refresh`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

