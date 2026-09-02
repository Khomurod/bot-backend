/**
 * Pinned load-context constants.
 *
 * The interactive timeouts matter operationally: a dispatcher is waiting on the
 * answer, so these are tighter than the background jobs' budgets. The inline
 * byte cap bounds what may be sent to a model at all — images are additionally
 * shrunk by services/aiImagePrep.js on the way out.
 *
 * Split out of services/dispatchPinnedContextService.js.
 */

const PINNED_CONTEXT_GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
];

const INTERACTIVE_GEMINI_MAX_RETRY_WAIT_MS = 8_000;

const INTERACTIVE_GROQ_TIMEOUT_MS = 20_000;

const MAX_INLINE_GEMINI_FILE_BYTES = 14 * 1024 * 1024;

/** Cap inline images/docs per Gemini request (albums). */
const MAX_ALBUM_INLINE_PARTS = 6;

const CHAT_HISTORY_LOOKBACK_DAYS = 8;

const STALE_STATUS_CHAT_MESSAGE_REGEX = /\b(pod|completed|cancel(?:led)?|picked up|status\s*:|rolling|stopped|miles?\s+left)\b/i;

const NO_CURRENT_LOAD_INFO_MESSAGE = 'No information about the current load is found';

function truncateDispatchEtaLogMessage(msg, maxLen = 480) {
  const s = String(msg || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}… (+${s.length - maxLen} chars)`;
}

module.exports = {
  PINNED_CONTEXT_GROQ_MODELS,
  INTERACTIVE_GEMINI_MAX_RETRY_WAIT_MS,
  INTERACTIVE_GROQ_TIMEOUT_MS,
  MAX_INLINE_GEMINI_FILE_BYTES,
  MAX_ALBUM_INLINE_PARTS,
  CHAT_HISTORY_LOOKBACK_DAYS,
  STALE_STATUS_CHAT_MESSAGE_REGEX,
  NO_CURRENT_LOAD_INFO_MESSAGE,
  truncateDispatchEtaLogMessage,
};
