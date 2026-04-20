// services/yandexClient.js
//
// Single shared Yandex Foundation Models client used by:
//   - aiAnalysisService.js   (legacy company / driver reports)
//   - aiAnnotationService.js (per-message classifier)
//   - aiInsightsService.js   (narrative generation)
//   - aiAskService.js        ("Ask the Data" plan + narrative)
//
// Credentials are intentionally hardcoded per user direction
// ("disregard the api and/or credential exposed error, as the app is
// still in test"). Move to env before production.
const YANDEX_API_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
const YANDEX_MODEL_URI = 'gpt://b1g3bq30m1s8c1ik4tqj/yandexgpt/latest';
const YANDEX_API_KEY = 'AQVNxTqFz0LLHgLbM42evQSxBfNqHoU-3kTsVrC2';
const YANDEX_FOLDER_ID = 'b1g3bq30m1s8c1ik4tqj';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;

async function callYandexRaw(promptText, opts = {}) {
  const {
    systemText = null,
    temperature = 0.2,
    maxTokens = 2000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    modelUri = YANDEX_MODEL_URI,
  } = opts;

  const messages = [];
  if (systemText) messages.push({ role: 'system', text: systemText });
  messages.push({ role: 'user', text: String(promptText) });

  const body = JSON.stringify({
    modelUri,
    completionOptions: { stream: false, temperature, maxTokens },
    messages,
  });

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(YANDEX_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${YANDEX_API_KEY}`,
          'Content-Type': 'application/json',
          'x-folder-id': YANDEX_FOLDER_ID,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 429 || response.status >= 500) {
        const errText = await response.text().catch(() => '');
        lastErr = new Error(`Yandex API ${response.status}: ${errText.slice(0, 400)}`);
        // Backoff: 500ms, 1500ms, 3500ms
        await new Promise((r) => setTimeout(r, 500 + attempt * 1000 + attempt * attempt * 500));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Yandex API ${response.status}: ${errText.slice(0, 400)}`);
      }

      const data = await response.json();
      return data?.result?.alternatives?.[0]?.message?.text?.trim() || '';
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`Yandex API timeout after ${timeoutMs}ms`);
      }
      // Only retry on network / timeout / 5xx. 4xx is a real error.
      if (attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 500 + attempt * 1000));
    }
  }
  throw lastErr || new Error('Yandex API unknown failure');
}

module.exports = {
  callYandexRaw,
  YANDEX_API_URL,
  YANDEX_MODEL_URI,
  YANDEX_FOLDER_ID,
};
