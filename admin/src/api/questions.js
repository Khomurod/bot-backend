/**
 * Survey questions and their responses.
 *
 * getResponses lives here rather than with the broadcast helpers it used to sit
 * next to: it reads the answers to a question, not a broadcast.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

export async function getQuestions() {
  const res = await fetch(`${API_BASE}/questions`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getQuestion(id) {
  const res = await fetch(`${API_BASE}/questions/${id}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createQuestion(data) {
  const res = await fetch(`${API_BASE}/questions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendQuestion(questionId) {
  const res = await fetch(`${API_BASE}/questions/${questionId}/send`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deactivateQuestion(questionId) {
  const res = await fetch(`${API_BASE}/questions/${questionId}/deactivate`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendTestQuestion(questionEn, optionsEn, mediaItems, mediaPosition) {
  const body = { question_en: questionEn, options_en: optionsEn };
  if (mediaItems && mediaItems.length > 0) {
    body.media_items = mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type }));
    body.media_position = mediaPosition || 'above';
  }
  const res = await fetch(`${API_BASE}/questions/send-test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}


export async function getResponses(questionId) {
  const res = await fetch(`${API_BASE}/responses/${questionId}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

