/**
 * Facebook lead auto-SMS: templates, pages, and the webhook delivery log.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

// ─── Facebook Leads auto-SMS ───

export async function getFacebookLeadAutoMessages() {
  const res = await fetch(`${API_BASE}/facebook-leads/auto-messages`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function saveFacebookLeadAutoMessages(payload) {
  const res = await fetch(`${API_BASE}/facebook-leads/auto-messages`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function previewFacebookLeadAutoMessage(payload) {
  const res = await fetch(`${API_BASE}/facebook-leads/auto-messages/preview`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getFacebookLeadPages() {
  const res = await fetch(`${API_BASE}/facebook-leads/pages`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getFacebookLeadWebhookLog(limit = 50) {
  const res = await fetch(`${API_BASE}/facebook-leads/webhook-log?limit=${limit}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function retryFacebookLeadWebhookEvent(id) {
  const res = await fetch(`${API_BASE}/facebook-leads/webhook-log/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

