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
  const res = await fetch(`${API_BASE}/groups`, { headers: getHeaders() });
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

export async function aiParseDriverProfiles(apply = false) {
  const res = await fetch(`${API_BASE}/driver-profiles/ai-parse?apply=${apply ? 'true' : 'false'}`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function runDriverProfilesAiSync(apply = true) {
  const res = await fetch(`${API_BASE}/driver-profiles/ai-sync?apply=${apply ? 'true' : 'false'}`, {
    method: 'POST',
    headers: getHeaders(),
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
    headers: getAuthHeader(),
    body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getDispatchTestingGroups() {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function saveDispatchEtaGlobalIntervals(payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/global-intervals`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getDispatchTestingGroupDetails(groupId) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/${groupId}/details`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateDispatchTestingGroup(groupId, payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/${groupId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateAllDispatchTestingGroups(payload) {
  const res = await fetch(`${API_BASE}/dispatch/testing-feature/groups/toggle-all`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
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

export async function getRaiseAssignableDrivers({ includeInactive = false, search = '' } = {}) {
  const params = new URLSearchParams();
  if (includeInactive) params.set('include_inactive', 'true');
  if (search) params.set('search', search);
  const qs = params.toString();
  const res = await fetch(`${RAISE_ADMIN}/assignable-drivers${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// Assign (or move, with force) a driver to a team. On a 409 conflict returns
// { conflict: true, error, conflictTeam } so the UI can offer "Move".
export async function assignRaiseDriver(teamId, { groupId, driverProfileId, force = false }) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${teamId}/assign-driver`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ groupId, driverProfileId, force }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { conflict: true, ...body };
  }
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function removeRaiseTeamDriver(driverId) {
  const res = await fetch(`${RAISE_ADMIN}/team-drivers/${driverId}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseTeamMembers(teamId) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${teamId}/members`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createRaiseTeamMember(teamId, member) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${teamId}/members`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(member || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateRaiseTeamMember(memberId, patch) {
  const res = await fetch(`${RAISE_ADMIN}/members/${memberId}`, {
    method: 'PATCH', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteRaiseTeamMember(memberId) {
  const res = await fetch(`${RAISE_ADMIN}/members/${memberId}`, {
    method: 'DELETE', headers: getHeaders(),
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

export async function updateHomeTimeStatus(groupId, patch) {
  const res = await fetch(`${API_BASE}/home-time/status/${groupId}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateHomeTimeStatusSince(groupId, stateSince) {
  return updateHomeTimeStatus(groupId, { state_since: stateSince });
}

export async function updateHomeTimeTrip(id, payload) {
  const res = await fetch(`${API_BASE}/home-time/history/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteHomeTimeTrip(id) {
  const res = await fetch(`${API_BASE}/home-time/history/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function importHomeTimeScreenshots(files) {
  const fd = new FormData();
  for (const f of files) fd.append('screenshots', f);
  const res = await fetch(`${API_BASE}/home-time/import-screenshots`, {
    method: 'POST', headers: getAuthHeader(), body: fd,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function applyHomeTimeImport(rows) {
  const res = await fetch(`${API_BASE}/home-time/import-screenshots/apply`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ rows }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getHomeTimeRequests() {
  const res = await fetch(`${API_BASE}/home-time/requests`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createHomeTimeRequest(payload) {
  const res = await fetch(`${API_BASE}/home-time/requests`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getGroupAccess() {
  const res = await fetch(`${API_BASE}/home-time/group-access`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function recheckGroupAccess() {
  const res = await fetch(`${API_BASE}/home-time/group-access/recheck`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getBotAccessSettings() {
  const res = await fetch(`${API_BASE}/home-time/access-settings`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateBotAccessSettings(payload) {
  const res = await fetch(`${API_BASE}/home-time/access-settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function requestGroupAdmin(groupId) {
  const res = await fetch(`${API_BASE}/home-time/group-access/request-admin/${groupId}`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

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

// ─── Bot Users (everyone who has tapped the bot's inline buttons) ───

export async function getBotUsers({ limit = 200, filter, search } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (filter && filter !== 'all') params.set('filter', filter);
  if (search) params.set('search', search);
  const res = await fetch(`${API_BASE}/bot-users?${params.toString()}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Bot Messages (registry of every message the bot has sent) ───

/** List bot-sent messages, newest first, with optional filters + pagination. */
export async function getBotMessages({ chatId, search, dateFrom, dateTo, includeDeleted, limit, offset } = {}) {
  const params = new URLSearchParams();
  if (chatId) params.set('chatId', chatId);
  if (search) params.set('search', search);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (includeDeleted === false) params.set('includeDeleted', 'false');
  if (limit != null) params.set('limit', String(limit));
  if (offset != null) params.set('offset', String(offset));
  const res = await fetch(`${API_BASE}/bot-messages?${params.toString()}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Edit a bot-sent message's text in Telegram by registry id. */
export async function editBotMessage(id, newText) {
  const res = await fetch(`${API_BASE}/bot-messages/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ newText }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Delete a bot-sent message in Telegram by registry id. */
export async function deleteBotMessage(id) {
  const res = await fetch(`${API_BASE}/bot-messages/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Settings: Google Maps Platform (Route Control) ───

/** Masked Google Maps settings (never returns the raw API key). */
export async function getGmapsSettings() {
  const res = await fetch(`${API_BASE}/settings/gmaps`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Update Google Maps settings. Omit the key to leave it unchanged. */
export async function updateGmapsSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/gmaps`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Test the Google Maps API key (candidate key optional). Returns { connected, message }. */
export async function testGmapsConnection(apiKey) {
  const res = await fetch(`${API_BASE}/settings/gmaps/test`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify(apiKey ? { apiKey } : {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Route Control ───

export async function getRouteAssignments(status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await fetch(`${API_BASE}/route-control${qs}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.assignments;
}

export async function getRouteAssignment(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Test-parse a Google Maps link without storing anything. Throws on unparseable. */
export async function parseRouteLink(url) {
  const res = await fetch(`${API_BASE}/route-control/parse`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ url }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.parsed;
}

export async function assignRoute(payload) {
  const res = await fetch(`${API_BASE}/route-control`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Assign a route WITH a screenshot: multipart with the JSON payload in a
 * `payload` field. No Content-Type header — the browser sets the boundary.
 */
export async function assignRouteWithScreenshot(payload, screenshotFile) {
  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload || {}));
  formData.append('screenshot', screenshotFile);
  const res = await fetch(`${API_BASE}/route-control`, {
    method: 'POST', headers: getAuthHeader(), body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Upload/replace the route screenshot on an existing assignment. */
export async function uploadRouteScreenshot(id, screenshotFile) {
  const formData = new FormData();
  formData.append('screenshot', screenshotFile);
  const res = await fetch(`${API_BASE}/route-control/${id}/screenshot`, {
    method: 'POST', headers: getAuthHeader(), body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Manually start tracking for a pending route. */
export async function startRouteTracking(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/start-tracking`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function computeRouteGeometry(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/compute`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Send (or re-send) the route message to the driver's Telegram group. */
export async function sendRouteDriverMessage(id, { message } = {}) {
  const res = await fetch(`${API_BASE}/route-control/${id}/send-driver-message`, {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify(message ? { message } : {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function cancelRoute(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/cancel`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function completeRoute(id) {
  const res = await fetch(`${API_BASE}/route-control/${id}/complete`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Settings: live-location (ELD) provider credentials ───

/** Masked ELD provider settings (never returns raw secrets). */
export async function getEldSettings() {
  const res = await fetch(`${API_BASE}/settings/eld`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Update ELD provider settings. Omit a secret field to leave it unchanged. */
export async function updateEldSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/eld`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/**
 * Live connectivity test for one provider ('samsara' | 'factor' | 'leader').
 * Optional candidate keys let you verify BEFORE saving; optional groupTitle
 * checks a specific unit. Returns { connected, message }.
 */
export async function testEldProvider(payload) {
  const res = await fetch(`${API_BASE}/settings/eld/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Settings: message routing (Telegram group per message category) ───

/** Telegram group IDs per bonus / review category (not secret — plaintext). */
export async function getMessageGroupSettings() {
  const res = await fetch(`${API_BASE}/settings/message-groups`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Update the Telegram group ID for one or more message categories. */
export async function updateMessageGroupSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/message-groups`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

// ─── Settings: RingCentral recruiter-call KPIs ───

export async function getRingCentralSettings() {
  const res = await fetch(`${API_BASE}/settings/ringcentral`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function updateRingCentralSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/ringcentral`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function testRingCentral(payload) {
  const res = await fetch(`${API_BASE}/settings/ringcentral/test`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Recruiters + call KPIs ───

export async function getRecruiters() {
  const res = await fetch(`${API_BASE}/recruiters`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data.recruiters) ? data.recruiters : [];
}

export async function createRecruiter(payload) {
  const res = await fetch(`${API_BASE}/recruiters`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateRecruiter(id, payload) {
  const res = await fetch(`${API_BASE}/recruiters/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteRecruiter(id) {
  const res = await fetch(`${API_BASE}/recruiters/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function syncRecruiterCalls(full = false) {
  const res = await fetch(`${API_BASE}/recruiters/sync${full ? '?full=1' : ''}`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRecruiterStats(date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(`${API_BASE}/recruiters/stats${qs}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Quick per-number connectivity test (auth + own call-log read). */
export async function testRecruiterConnection(id, payload) {
  const res = await fetch(`${API_BASE}/recruiters/${id}/test`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Stepwise per-number diagnostic (creds → auth → identity → call log). */
export async function diagnoseRecruiter(id, payload) {
  const res = await fetch(`${API_BASE}/recruiters/${id}/diagnose`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Public (no-auth) recruiter stats for the /recruiters leaderboard.
 * No params = today (live); { date } = one historical day;
 * { start, end } = inclusive date range (max 31 days).
 */
export async function getPublicRecruiterStats(params = {}) {
  const qs = new URLSearchParams();
  if (params.start && params.end) {
    qs.set('start', params.start);
    qs.set('end', params.end);
  } else if (params.date) {
    qs.set('date', params.date);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${API_BASE}/recruiters/public-stats${suffix}`);
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Live Locations (map of all active units) ───

/** Map tile provider config (tile URL/attribution live server-side, admin-only). */
export async function getLiveLocationsConfig() {
  const res = await fetch(`${API_BASE}/live-locations/config`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Normalized, map-ready snapshot of all active units (location + load + ETA). */
export async function getLiveLocationsSnapshot({ force = false } = {}) {
  const qs = force ? '?force=1' : '';
  const res = await fetch(`${API_BASE}/live-locations/snapshot${qs}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Precise routed ETA + route line for one selected unit. */
export async function getLiveLocationRoute(unit) {
  const res = await fetch(`${API_BASE}/live-locations/route?unit=${encodeURIComponent(unit)}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ── Safety-event driver-group music overlay ─────────────────────────────────
// Returns { settings, activeMusic, musicAssets } (music bytes are never included).
export async function getSafetyEventSettings() {
  const res = await fetch(`${API_BASE}/settings/safety-events`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateSafetyEventSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/safety-events`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Upload a music clip (multipart). Returns the refreshed settings view. */
export async function uploadSafetyEventMusic(file, { name, description } = {}) {
  const formData = new FormData();
  formData.append('file', file);
  if (name) formData.append('name', name);
  if (description) formData.append('description', description);
  const res = await fetch(`${API_BASE}/settings/safety-events/music`, {
    method: 'POST',
    headers: getAuthHeader(),
    body: formData,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function activateSafetyEventMusic(id) {
  const res = await fetch(`${API_BASE}/settings/safety-events/music/${id}/activate`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deactivateSafetyEventMusic(id) {
  const res = await fetch(`${API_BASE}/settings/safety-events/music/${id}/deactivate`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteSafetyEventMusic(id) {
  const res = await fetch(`${API_BASE}/settings/safety-events/music/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Trailer Tracking (Beta) ───
export async function getTrailers(params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const res = await fetch(`${API_BASE}/trailers${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailer(id) {
  const res = await fetch(`${API_BASE}/trailers/${id}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerEvents(params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const res = await fetch(`${API_BASE}/trailers/events${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerTimeline(id) {
  const res = await fetch(`${API_BASE}/trailers/${id}/events`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerUnidentified(includeResolved = false) {
  const res = await fetch(`${API_BASE}/trailers/unidentified?includeResolved=${includeResolved ? 'true' : 'false'}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerMapData() {
  const res = await fetch(`${API_BASE}/trailers/map`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerSettings() {
  const res = await fetch(`${API_BASE}/trailers/settings`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateTrailerSettings(patch) {
  const res = await fetch(`${API_BASE}/trailers/settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function saveTrailer(trailer) {
  const res = await fetch(`${API_BASE}/trailers`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(trailer),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateTrailer(id, patch) {
  const res = await fetch(`${API_BASE}/trailers/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function importTrailerScreenshot(files) {
  const fd = new FormData();
  for (const f of files) fd.append('screenshots', f);
  const res = await fetch(`${API_BASE}/trailers/import/screenshot`, {
    method: 'POST', headers: getAuthHeader(), body: fd,
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function commitTrailerImport(batchId, rows) {
  const res = await fetch(`${API_BASE}/trailers/import/${batchId}/commit`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ rows }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getTrailerImportBatches() {
  const res = await fetch(`${API_BASE}/trailers/import/batches`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function registerManualTrailerEvent(payload) {
  const res = await fetch(`${API_BASE}/trailers/events/manual`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function correctTrailerEvent(id, patch) {
  const res = await fetch(`${API_BASE}/trailers/events/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function resolveTrailerUnidentified(id) {
  const res = await fetch(`${API_BASE}/trailers/unidentified/${id}/resolve`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Accept the latest detected change for an event (confirm; keep status). */
export async function acceptTrailerEvent(id, note) {
  const res = await fetch(`${API_BASE}/trailers/events/${id}/accept`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ note: note || null }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Decline the latest detected change (kept in history; status restored). */
export async function declineTrailerEvent(id, note) {
  const res = await fetch(`${API_BASE}/trailers/events/${id}/decline`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ note: note || null }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Recompute a trailer's current status from its non-declined event history. */
export async function recomputeTrailerStatus(id) {
  const res = await fetch(`${API_BASE}/trailers/${id}/recompute-status`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Run the admin-triggered, bounded geocode backfill. */
export async function runTrailerGeocodeBackfill(limit) {
  const res = await fetch(`${API_BASE}/trailers/geocode-backfill`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ limit: limit || undefined }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
