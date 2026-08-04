/**
 * Employee birthdays: the roster, its settings, and the greetings sent.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

export async function getEmployeeBirthdays() {
  const res = await fetch(`${API_BASE}/employee-birthdays`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getEmployeeBirthdaySettings() {
  const res = await fetch(`${API_BASE}/employee-birthdays/settings`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateEmployeeBirthdaySettings(data) {
  const res = await fetch(`${API_BASE}/employee-birthdays/settings`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendEmployeeBirthdayWishesNow() {
  const res = await fetch(`${API_BASE}/employee-birthdays/send-now`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function congratulateEmployees(employeeIds) {
  const res = await fetch(`${API_BASE}/employee-birthdays/congratulate`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ employeeIds }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendEmployeeGroupCustomMessage(message) {
  const res = await fetch(`${API_BASE}/employee-birthdays/send-custom`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ message }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendEmployeeBirthdayRequest() {
  const res = await fetch(`${API_BASE}/employee-birthdays/request`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createEmployeeBirthday(data) {
  const res = await fetch(`${API_BASE}/submit-employee-birthday`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify(data)
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateEmployeeBirthday(id, data) {
  const res = await fetch(`${API_BASE}/employee-birthdays/${id}`, {
    method: 'PUT', headers: getHeaders(),
    body: JSON.stringify(data)
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteEmployeeBirthday(id) {
  const res = await fetch(`${API_BASE}/employee-birthdays/${id}`, {
    method: 'DELETE', headers: getHeaders()
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

