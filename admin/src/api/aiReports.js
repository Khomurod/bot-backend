/**
 * AI-generated reports.
 *
 * Two generations live here: the original driver/company reports, and the
 * card-based Insights v2 reports. Both end in a Telegram message, hence the
 * message edit/delete helpers.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

export async function getAiReports(type = 'driver', includeSent = false) {
  const res = await fetch(`${API_BASE}/ai-reports?type=${encodeURIComponent(type)}&includeSent=${includeSent ? 'true' : 'false'}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function generateAiReport(params = {}) {
  const body = typeof params === 'number'
    ? { reportType: 'company', daysBack: params }
    : {
      reportType: params.reportType || 'company',
      groupId: params.groupId ?? null,
      daysBack: params.daysBack ?? 7,
    };
  const res = await fetch(`${API_BASE}/ai-reports/generate`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendAiReport(reportId, editedText) {
  const res = await fetch(`${API_BASE}/ai-reports/${reportId}/send`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ editedText }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function discardAiReport(reportId) {
  const res = await fetch(`${API_BASE}/ai-reports/${reportId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function testGroqAi() {
  const res = await fetch(`${API_BASE}/ai-reports/test-groq`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ── AI Insights v2 (card-based reports) ──
export async function generateAiInsightReport(daysBack = 7) {
  const res = await fetch(`${API_BASE}/ai-insights/generate`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ daysBack }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function listAiInsightReports(limit = 20) {
  const res = await fetch(`${API_BASE}/ai-insights/reports?limit=${limit}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getAiInsightReport(reportId) {
  const res = await fetch(`${API_BASE}/ai-insights/reports/${reportId}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateAiInsightCard(cardId, status, opts = {}) {
  const res = await fetch(`${API_BASE}/ai-insights/cards/${cardId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ status, feedback: opts.feedback || null, patch: opts.patch || null }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendAiInsightReport(reportId) {
  const res = await fetch(`${API_BASE}/ai-insights/reports/${reportId}/send`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function backfillAnnotations(daysBack = 30) {
  const res = await fetch(`${API_BASE}/ai-insights/annotate`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ daysBack }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function editTelegramMessage(url, newText) {
  const res = await fetch(`${API_BASE}/message/edit`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ url, newText })
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteTelegramMessage(url) {
  const res = await fetch(`${API_BASE}/message/delete`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ url })
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

