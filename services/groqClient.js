// services/groqClient.js
//
// Shared Groq chat-completions client used by:
//   - aiAnalysisService.js   (legacy company / driver reports)
//   - aiAnnotationService.js (per-message classifier)
//   - aiInsightsService.js   (narrative generation)
//   - aiAskService.js        ("Ask the Data" plan + narrative)
//   - datUiInspectorService.js (DAT layout inspector)
//
require('dotenv').config();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_AI_MODEL = process.env.GROQ_AI_MODEL || 'llama-3.3-70b-versatile';
const GROQ_AI_FAST_MODEL = process.env.GROQ_AI_FAST_MODEL || 'llama-3.1-8b-instant';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;

function isAuthOrConfigError(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('not configured')
    || m.includes('401')
    || m.includes('403')
    || m.includes('invalid api key')
    || m.includes('unauthorized')
  );
}

async function callGroqRaw(promptText, opts = {}) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const {
    systemText = null,
    temperature = 0.2,
    maxTokens = 2000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    model = GROQ_AI_MODEL,
  } = opts;

  const messages = [];
  if (systemText) messages.push({ role: 'system', content: String(systemText) });
  messages.push({ role: 'user', content: String(promptText) });

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const rawText = await response.text().catch(() => '');
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch (_) {
        payload = {};
      }
      const apiMessage = payload?.error?.message || rawText.slice(0, 400);

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Groq API ${response.status}: ${apiMessage}`);
      }

      if (response.status === 429 || response.status >= 500) {
        lastErr = new Error(`Groq API ${response.status}: ${apiMessage}`);
        await new Promise((r) => setTimeout(r, 500 + attempt * 1000 + attempt * attempt * 500));
        continue;
      }

      if (!response.ok) {
        throw new Error(`Groq API ${response.status}: ${apiMessage}`);
      }

      return String(payload?.choices?.[0]?.message?.content || '').trim();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`Groq API timeout after ${timeoutMs}ms`);
      }
      if (isAuthOrConfigError(lastErr.message)) break;
      if (attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 500 + attempt * 1000));
    }
  }
  throw lastErr || new Error('Groq API unknown failure');
}

module.exports = {
  callGroqRaw,
  isAuthOrConfigError,
  GROQ_API_URL,
  GROQ_API_KEY,
  GROQ_AI_MODEL,
  GROQ_AI_FAST_MODEL,
};
