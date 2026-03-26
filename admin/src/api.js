const API_BASE = '/api';

function getHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function getAuthHeader() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function login(username, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Login failed');
  }
  const data = await res.json();
  localStorage.setItem('token', data.token);
  return data;
}

export async function verifyAuth() {
  const res = await fetch(`${API_BASE}/auth/verify`, {
    headers: getHeaders(),
  });
  return res.ok;
}

export function logout() {
  localStorage.removeItem('token');
}

export async function getGroups() {
  const res = await fetch(`${API_BASE}/groups`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch groups');
  return res.json();
}

export async function setGroupLanguage(groupId, language) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/language`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ language }),
  });
  if (!res.ok) throw new Error('Failed to update language');
  return res.json();
}

export async function getQuestions() {
  const res = await fetch(`${API_BASE}/questions`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch questions');
  return res.json();
}

export async function getQuestion(id) {
  const res = await fetch(`${API_BASE}/questions/${id}`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch question');
  return res.json();
}

export async function createQuestion(data) {
  const res = await fetch(`${API_BASE}/questions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create question');
  }
  return res.json();
}

export async function sendQuestion(questionId) {
  const res = await fetch(`${API_BASE}/questions/${questionId}/send`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to send question');
  }
  return res.json();
}

export async function deactivateQuestion(questionId) {
  const res = await fetch(`${API_BASE}/questions/${questionId}/deactivate`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error('Failed to deactivate question');
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
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to send test question');
  }
  return res.json();
}

export async function sendBroadcast(messageText, parseMode, messages, mediaItems, mediaPosition) {
  const body = { message_text: messageText, parse_mode: parseMode };
  if (messages) body.messages = messages;
  if (mediaItems && mediaItems.length > 0) {
    body.media_items = mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type }));
    body.media_position = mediaPosition || 'above';
  }
  const res = await fetch(`${API_BASE}/broadcast/send`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to send broadcast');
  }
  return res.json();
}

export async function sendBroadcastTest(messageText, parseMode, mediaItems, mediaPosition) {
  const body = { message_text: messageText, parse_mode: parseMode };
  if (mediaItems && mediaItems.length > 0) {
    body.media_items = mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type }));
    body.media_position = mediaPosition || 'above';
  }
  const res = await fetch(`${API_BASE}/broadcast/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to send broadcast test');
  }
  return res.json();
}

export async function getResponses(questionId) {
  const res = await fetch(`${API_BASE}/responses/${questionId}`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch responses');
  return res.json();
}

export async function translateTexts(textBlocks) {
  const res = await fetch(`${API_BASE}/translate`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      source_language: 'en',
      target_languages: ['ru', 'uz'],
      text_blocks: textBlocks,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Translation failed. Please try again.');
  }
  return res.json();
}

/**
 * Upload a media file (photo or video) to Telegram via the server.
 * Returns { file_id, media_type } from Telegram.
 * Note: No Content-Type header — browser sets it with boundary for FormData.
 */
export async function uploadMedia(file) {
  const formData = new FormData();
  formData.append('media', file);
  const res = await fetch(`${API_BASE}/upload-media`, {
    method: 'POST',
    headers: getAuthHeader(),
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to upload media');
  }
  return res.json();
}

// ─── Employee Voting API ───

export async function getDriverUnits() {
  const res = await fetch(`${API_BASE}/voting/units`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch driver units');
  return res.json();
}

export async function getVotingPolls() {
  const res = await fetch(`${API_BASE}/voting/polls`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch polls');
  return res.json();
}

export async function createVotingPoll(question) {
  const res = await fetch(`${API_BASE}/voting/polls`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create poll');
  }
  return res.json();
}

export async function getPollResults(pollId) {
  const res = await fetch(`${API_BASE}/voting/polls/${pollId}/results`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch poll results');
  return res.json();
}

export async function getPollVoters(pollId) {
  const res = await fetch(`${API_BASE}/voting/polls/${pollId}/voters`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch poll voters');
  return res.json();
}

export async function closePoll(pollId) {
  const res = await fetch(`${API_BASE}/voting/polls/${pollId}/close`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error('Failed to close poll');
  return res.json();
}

export async function resetPoll(pollId) {
  const res = await fetch(`${API_BASE}/voting/polls/${pollId}/reset`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error('Failed to reset poll');
  return res.json();
}

// ─── Scheduled Messages API ───

export async function getDriverGroups() {
  const res = await fetch(`${API_BASE}/groups/driver-list`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch driver groups');
  return res.json();
}

export async function createScheduledMessage(data) {
  const res = await fetch(`${API_BASE}/scheduled-messages`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create scheduled message');
  }
  return res.json();
}

export async function getScheduledMessages() {
  const res = await fetch(`${API_BASE}/scheduled-messages`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch scheduled messages');
  return res.json();
}

export async function cancelScheduledMessage(id) {
  const res = await fetch(`${API_BASE}/scheduled-messages/${id}/cancel`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to cancel message');
  }
  return res.json();
}

export async function sendScheduledMessageNow(id) {
  const res = await fetch(`${API_BASE}/scheduled-messages/${id}/send-now`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to send message');
  }
  return res.json();
}

// ─── Confirmation Broadcast API ───

export async function sendConfirmationBroadcast(messageText, parseMode, messages, mediaItems, mediaPosition, buttons) {
  const body = { message_text: messageText, parse_mode: parseMode, buttons };
  if (messages) body.messages = messages;
  if (mediaItems && mediaItems.length > 0) {
    body.media_items = mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type }));
    body.media_position = mediaPosition || 'above';
  }
  const res = await fetch(`${API_BASE}/broadcast/confirmation/send`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to send confirmation broadcast');
  }
  return res.json();
}

export async function sendConfirmationBroadcastTest(messageText, parseMode, mediaItems, mediaPosition, buttons) {
  const body = { message_text: messageText, parse_mode: parseMode, buttons };
  if (mediaItems && mediaItems.length > 0) {
    body.media_items = mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type }));
    body.media_position = mediaPosition || 'above';
  }
  const res = await fetch(`${API_BASE}/broadcast/confirmation/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to send confirmation broadcast test');
  }
  return res.json();
}

export async function getBroadcasts(type) {
  const res = await fetch(`${API_BASE}/broadcasts?type=${encodeURIComponent(type || 'regular')}`, {
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error('Failed to fetch broadcasts');
  return res.json();
}

export async function getBroadcastDeliveries(broadcastId) {
  const res = await fetch(`${API_BASE}/broadcasts/${broadcastId}/deliveries`, {
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error('Failed to fetch deliveries');
  return res.json();
}

export async function getBroadcastButtonClicks(broadcastId) {
  const res = await fetch(`${API_BASE}/broadcasts/${broadcastId}/clicks`, {
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error('Failed to fetch button clicks');
  return res.json();
}
