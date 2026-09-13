/**
 * Finance page — admin API client.
 *
 * Separate from `api/finance.js`, which is the SETTINGS client. These two talk
 * to different routers with different rules: the settings one answers with
 * counts, this one is the single place captured payment text is read out, and
 * keeping them apart keeps that distinction visible at the import site.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

async function get(path) {
  const res = await fetch(`${API_BASE}/finance${path}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

async function post(path) {
  const res = await fetch(`${API_BASE}/finance${path}`, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export const listFinanceMessages = (status) =>
  get(`/messages${status ? `?status=${encodeURIComponent(status)}` : ''}`);

export const listFinanceMoneycodes = (duplicatesOnly) =>
  get(`/moneycodes${duplicatesOnly ? '?duplicates=true' : ''}`);

export const listFinanceDocuments = (status) =>
  get(`/documents${status ? `?status=${encodeURIComponent(status)}` : ''}`);

export const listFinanceReports = () => get('/reports');

/** Re-read one stored message with the CURRENT parser. Changes no text. */
export const reparseFinanceMessage = (id) => post(`/messages/${id}/reparse`);

/** Put a document Wenze could not FETCH back in the queue. */
export const retryFinanceDocument = (id) => post(`/documents/${id}/retry`);
