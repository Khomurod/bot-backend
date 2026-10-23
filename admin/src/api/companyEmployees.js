/**
 * Users → Company Employees: the staff list with the American name, the
 * Telegram account and the photo the birthday card needs.
 */

import { API_BASE, getHeaders, getAuthHeader, handleApiError } from './http';

const BASE = `${API_BASE}/company-employees`;

export async function getCompanyEmployees() {
  const res = await fetch(BASE, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateCompanyEmployee(id, data) {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function confirmCompanyEmployeeTelegram(id) {
  const res = await fetch(`${BASE}/${id}/confirm-telegram`, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function suggestCompanyEmployeeTelegram() {
  const res = await fetch(`${BASE}/suggest-telegram`, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** No Content-Type header — the browser sets it, with the boundary, for FormData. */
export async function uploadCompanyEmployeePhoto(id, file) {
  const form = new FormData();
  form.append('photo', file);
  const res = await fetch(`${BASE}/${id}/photo`, { method: 'PUT', headers: getAuthHeader(), body: form });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteCompanyEmployeePhoto(id) {
  const res = await fetch(`${BASE}/${id}/photo`, { method: 'DELETE', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * The birthday card as it would be posted, as an object URL (an <img> cannot
 * send the bearer token). The caller revokes it.
 */
export async function getCompanyEmployeeCardUrl(id) {
  const res = await fetch(`${BASE}/${id}/card`, { headers: getAuthHeader() });
  if (!res.ok) { await handleApiError(res); }
  return URL.createObjectURL(await res.blob());
}
