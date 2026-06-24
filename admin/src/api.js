async function handleApiError(res) {
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
  if (!res.ok) { await handleApiError(res); }
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
  const token = localStorage.getItem('token');
  const endpoint = token ? `${API_BASE}/groups` : `${API_BASE}/dispatch/groups`;
  const headers = token ? getHeaders() : {};
  const res = await fetch(endpoint, { headers });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data) ? data : (data?.groups ?? []);
}

/** All driver groups (active + inactive) for Groups page and broadcast driver picker. */
export async function getGroupsManage() {
  const res = await fetch(`${API_BASE}/groups/manage`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function getBroadcastPlaceholders() {
  const res = await fetch(`${API_BASE}/broadcast/placeholders`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data?.placeholders) ? data.placeholders : [];
}

export async function getDriverProfiles({ includeInactive = true, needsReviewOnly = false } = {}) {
  const params = new URLSearchParams();
  params.set('include_inactive', includeInactive ? 'true' : 'false');
  if (needsReviewOnly) params.set('needs_review_only', 'true');
  const res = await fetch(`${API_BASE}/driver-profiles?${params.toString()}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function updateDriverProfile(profileId, payload) {
  const res = await fetch(`${API_BASE}/driver-profiles/${profileId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

function appendTargetActiveFilter(body, targetType, targetActiveFilter) {
  if (targetType === 'all' || targetType === 'language_groups') {
    body.target_active_filter = targetActiveFilter || 'active';
  }
  return body;
}

export async function setGroupLanguage(groupId, language) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/language`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ language }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function setGroupBirthday(groupId, birthday) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/birthday`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ birthday: birthday || null }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function setGroupStatus(groupId, active) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/status`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ active }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function runGroupStatusAi() {
  const res = await fetch(`${API_BASE}/groups/status/run-now`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}


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

// Support both object and positional arguments for compatibility
export async function sendBroadcast(dataOrText, parseMode, messages, mediaItems, mediaPosition, groupIds) {
  let body;
  if (typeof dataOrText === 'object') {
    if (dataOrText.type === 'confirmation') {
      return sendConfirmationBroadcast(dataOrText);
    }
    const {
      messageEn,
      messageRu,
      messageUz,
      type,
      targetType,
      targetActiveFilter,
      selectedDriverIds,
      selectedLanguages,
      forceLanguage,
      mediaItems: items,
      mediaPosition: pos,
    } = dataOrText;
    body = {
      message_text: messageEn,
      messages: { en: messageEn, ru: messageRu, uz: messageUz },
      target_type: targetType || 'all',
      target_driver_ids: targetType === 'specific_drivers' ? selectedDriverIds : undefined,
      target_languages: targetType === 'language_groups' ? selectedLanguages : undefined,
      force_language: forceLanguage || null,
      media_items: items ? items.map(m => ({ file_id: m.file_id, media_type: m.type })) : null,
      media_position: pos || 'above',
    };
    appendTargetActiveFilter(body, targetType || 'all', targetActiveFilter);
  } else {
    body = { message_text: dataOrText, parse_mode: parseMode };
    if (messages) body.messages = messages;
    if (groupIds && groupIds.length > 0) body.group_ids = groupIds;
    if (mediaItems && mediaItems.length > 0) {
      body.media_items = mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type }));
      body.media_position = mediaPosition || 'above';
    }
  }
  
  const res = await fetch(`${API_BASE}/broadcast/send`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function testBroadcast(data) {
  if (data.type === 'confirmation') {
    return sendConfirmationBroadcastTest(data);
  }
  const { messageEn, messageRu, messageUz, mediaItems, mediaPosition, forceLanguage } = data;
  const body = {
    message_text: messageEn,
    messages: { en: messageEn, ru: messageRu, uz: messageUz },
    force_language: forceLanguage || null,
    media_items: mediaItems ? mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type })) : null,
    media_position: mediaPosition || 'above',
  };
  const res = await fetch(`${API_BASE}/broadcast/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// Positional version for compatibility
export async function sendBroadcastTest(messageText, parseMode, mediaItems, mediaPosition) {
    return testBroadcast({ messageEn: messageText, mediaItems, mediaPosition });
}

export async function getResponses(questionId) {
  const res = await fetch(`${API_BASE}/responses/${questionId}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
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
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const ru = Array.isArray(data.ru) ? data.ru : (typeof data.ru === "string" ? [data.ru] : []);
    const uz = Array.isArray(data.uz) ? data.uz : (typeof data.uz === "string" ? [data.uz] : []);
    const max = Math.max(ru.length, uz.length, textBlocks.length || 0);
    return Array.from({ length: max }, (_, idx) => ({
      ru: ru[idx] || "",
      uz: uz[idx] || "",
    }));
  }
  return [];
}

// Alias for App.jsx compatibility
export async function translateBroadcast(text) {
  const rows = await translateTexts([text]);
  return rows[0] || { ru: "", uz: "" };
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
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return {
    ...data,
    type: data.type || data.media_type || (file.type.startsWith("video/") ? "video" : "photo"),
  };
}

// ─── Employee Voting API ───

export async function parseDispatchRateCon(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/dispatch/parse-rate-con`, {
    method: 'POST',
    headers: getAuthHeader(),
    body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendDispatchToTelegram(formData) {
  const res = await fetch(`${API_BASE}/dispatch/send-to-telegram`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getDispatchTestingGroups() {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups`);
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function saveDispatchEtaGlobalIntervals(payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/global-intervals`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getDispatchTestingGroupDetails(groupId) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/${groupId}/details`);
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateDispatchTestingGroup(groupId, payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/${groupId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateAllDispatchTestingGroups(payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/toggle-all`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getDriverUnits() {
  const res = await fetch(`${API_BASE}/voting/units`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getVotingPolls() {
  const res = await fetch(`${API_BASE}/voting/polls`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createVotingPoll(question) {
  const res = await fetch(`${API_BASE}/voting/polls`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ question }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getPollResults(pollId) {
  const res = await fetch(`${API_BASE}/voting/polls/${pollId}/results`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getPollVoters(pollId) {
  const res = await fetch(`${API_BASE}/voting/polls/${pollId}/voters`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function closePoll(pollId) {
  const res = await fetch(`${API_BASE}/voting/polls/${pollId}/close`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function resetPoll(pollId) {
  const res = await fetch(`${API_BASE}/voting/polls/${pollId}/reset`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Scheduled Messages API ───

export async function getDriverGroups() {
  const res = await fetch(`${API_BASE}/groups/driver-list`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createScheduledMessage(data) {
  const {
    messageEn,
    messageRu,
    messageUz,
    mediaItems,
    mediaPosition,
    targetType,
    targetActiveFilter,
    selectedDriverIds,
    selectedLanguages,
    forceLanguage,
    scheduleType,
    scheduledAtChicago,
    weeklyDayOfWeek,
    weeklyTimeChicago,
    scheduleTimezone,
  } = data;
  const body = messageEn !== undefined
    ? {
        message_text_en: messageEn,
        message_text_ru: messageRu || null,
        message_text_uz: messageUz || null,
        target_type: targetType || 'all',
        target_driver_ids: targetType === 'specific_drivers' ? selectedDriverIds : undefined,
        target_languages: targetType === 'language_groups' ? selectedLanguages : undefined,
        force_language: forceLanguage || null,
        media_items: mediaItems && mediaItems.length > 0
          ? mediaItems.map((m) => ({ file_id: m.file_id, media_type: m.type || m.media_type }))
          : null,
        media_position: mediaPosition || 'above',
        schedule_type: scheduleType || 'one_time',
        scheduled_at_chicago: scheduleType === 'weekly' ? null : scheduledAtChicago,
        weekly_day_of_week: scheduleType === 'weekly' ? weeklyDayOfWeek : null,
        weekly_time_chicago: scheduleType === 'weekly' ? weeklyTimeChicago : null,
        schedule_timezone: scheduleTimezone || 'America/Chicago',
      }
    : data;
  if (messageEn !== undefined) {
    appendTargetActiveFilter(body, targetType || 'all', targetActiveFilter);
  }

  const res = await fetch(`${API_BASE}/scheduled-messages`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getScheduledMessages() {
  const res = await fetch(`${API_BASE}/scheduled-messages`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function cancelScheduledMessage(id) {
  const res = await fetch(`${API_BASE}/scheduled-messages/${id}/cancel`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendScheduledMessageNow(id) {
  const res = await fetch(`${API_BASE}/scheduled-messages/${id}/send-now`, {
    method: 'PUT',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Confirmation Broadcast API ───

export async function sendConfirmationBroadcast(data) {
  const {
    messageEn,
    messageRu,
    messageUz,
    buttons,
    mediaItems,
    mediaPosition,
    targetType,
    targetActiveFilter,
    selectedDriverIds,
    selectedLanguages,
    forceLanguage,
  } = data;
  const body = {
    message_text: messageEn,
    messages: { en: messageEn, ru: messageRu, uz: messageUz },
    buttons,
    target_type: targetType || 'all',
    target_driver_ids: targetType === 'specific_drivers' ? selectedDriverIds : undefined,
    target_languages: targetType === 'language_groups' ? selectedLanguages : undefined,
    force_language: forceLanguage || null,
    media_items: mediaItems ? mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type })) : null,
    media_position: mediaPosition || 'above',
  };
  appendTargetActiveFilter(body, targetType || 'all', targetActiveFilter);
  const res = await fetch(`${API_BASE}/broadcast/confirmation/send`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendConfirmationBroadcastTest(data) {
  const {
    messageEn,
    messageRu,
    messageUz,
    buttons,
    mediaItems,
    mediaPosition,
    targetType,
    selectedDriverIds,
    selectedLanguages,
    forceLanguage,
  } = data;
  const body = {
    message_text: messageEn,
    messages: { en: messageEn, ru: messageRu, uz: messageUz },
    buttons,
    force_language: forceLanguage || null,
    target_type: targetType || 'all',
    target_driver_ids: targetType === 'specific_drivers' ? selectedDriverIds : undefined,
    target_languages: targetType === 'language_groups' ? selectedLanguages : undefined,
    media_items: mediaItems ? mediaItems.map(m => ({ file_id: m.file_id, media_type: m.type })) : null,
    media_position: mediaPosition || 'above',
  };
  const res = await fetch(`${API_BASE}/broadcast/confirmation/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getBroadcasts(type) {
  const res = await fetch(`${API_BASE}/broadcasts?type=${encodeURIComponent(type || 'regular')}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// Alias for App.jsx compatibility
export const getBroadcastHistory = getBroadcasts;

export async function getBroadcastDeliveries(broadcastId) {
  const res = await fetch(`${API_BASE}/broadcasts/${broadcastId}/deliveries`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getBroadcastButtonClicks(broadcastId) {
  const res = await fetch(`${API_BASE}/broadcasts/${broadcastId}/clicks`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// Alias for App.jsx compatibility
export const getConfirmationClicks = getBroadcastButtonClicks;

export async function getChatLogs() {
  const res = await fetch(`${API_BASE}/chat-logs?t=${Date.now()}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getLeads(source = '') {
  const params = new URLSearchParams({ t: String(Date.now()) });
  if (source) params.set('source', source);
  const res = await fetch(`${API_BASE}/leads?${params.toString()}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

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

export async function askTheData(question) {
  const res = await fetch(`${API_BASE}/ai-ask`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ question }),
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

// ─── Driver Raise Approval (75¢/mile) — admin ───

const RAISE_ADMIN = `${API_BASE}/raise/admin`;

export async function getRaiseSettings() {
  const res = await fetch(`${RAISE_ADMIN}/settings`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateRaiseSettings(patch) {
  const res = await fetch(`${RAISE_ADMIN}/settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseCompanyDrivers() {
  const res = await fetch(`${RAISE_ADMIN}/company-drivers`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseTeams() {
  const res = await fetch(`${RAISE_ADMIN}/teams`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createRaiseTeam(name) {
  const res = await fetch(`${RAISE_ADMIN}/teams`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ name }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateRaiseTeam(id, patch) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${id}`, {
    method: 'PATCH', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteRaiseTeam(id) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseTeamDrivers(id) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${id}/drivers`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function setRaiseTeamDrivers(id, drivers) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${id}/drivers`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ drivers }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function raiseSendNow(payload) {
  const res = await fetch(`${RAISE_ADMIN}/send-now`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseRounds() {
  const res = await fetch(`${RAISE_ADMIN}/rounds`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseRoundResults(id) {
  const res = await fetch(`${RAISE_ADMIN}/rounds/${id}/results`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function closeRaiseRound(id) {
  const res = await fetch(`${RAISE_ADMIN}/rounds/${id}/close`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Driver Raise Approval — public (no auth, token-based) ───

export async function getRaisePublicInfo(token) {
  const res = await fetch(`${API_BASE}/raise/${token}`);
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function raiseRequestOtp(token, payload) {
  const res = await fetch(`${API_BASE}/raise/${token}/request-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function raiseVerifyOtp(token, payload) {
  const res = await fetch(`${API_BASE}/raise/${token}/verify-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function raiseSubmit(token, payload) {
  const res = await fetch(`${API_BASE}/raise/${token}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Driver Home-Time Tracking ───

export async function getHomeTimeOverview() {
  const res = await fetch(`${API_BASE}/home-time/overview`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateHomeTimeSettings(patch) {
  const res = await fetch(`${API_BASE}/home-time/settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
