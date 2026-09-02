/**
 * Classifying AI failures, and cleaning AI output — pure functions.
 *
 * The distinction that matters: a TRANSIENT error is worth retrying, an
 * exhausted quota is not, and a dispatcher is waiting either way. Getting this
 * wrong either wastes their time or drops a load they could have had.
 *
 * Split out of server/services/dispatchParserService.js.
 */

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterMs(response) {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return 0;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.ceil(seconds * 1000), 5000);
  }
  return 0;
}

function isGroqTransientError(status, message) {
  return status === 429
    || status === 503
    || status >= 500
    || /rate limit/i.test(message || '')
    || /too many requests/i.test(message || '')
    || /service unavailable/i.test(message || '')
    || /try again/i.test(message || '');
}

function isGeminiQuotaExhaustedError(status, message) {
  if (status !== 429) return false;
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('quota')
    || normalized.includes('resource_exhausted')
    || normalized.includes('limit')
    || normalized.includes('daily')
    || normalized.includes('exceeded');
}

function isGeminiTransientError(status, message) {
  const normalized = String(message || '').toLowerCase();
  return status === 503
    || status >= 500
    || normalized.includes('high demand')
    || normalized.includes('try again')
    || normalized.includes('temporarily unavailable');
}

function stripMarkdownFences(text) {
  return String(text || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function sanitizeDispatchOutput(text) {
  return String(text || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeParseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  sleep,
  parseRetryAfterMs,
  isGroqTransientError,
  isGeminiQuotaExhaustedError,
  isGeminiTransientError,
  stripMarkdownFences,
  sanitizeDispatchOutput,
  safeParseJsonObject,
};
