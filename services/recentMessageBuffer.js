/**
 * Recent group-message buffer (in-memory, no DB).
 *
 * The bot does not persist every group message (only load-relevant ones), but
 * the home-time request feature needs the last ~30 minutes of a group's chat to
 * give the AI enough context to tell a home-time request apart from an ordinary
 * tag. This keeps a tiny rolling buffer per Telegram group: cheap, restart-safe
 * (a fresh process just has no history yet), and self-pruning.
 */
const WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PER_GROUP = 80; // hard cap so a chatty group can't grow unbounded

// telegramGroupId (string) -> [{ at: ms, sender, text }]
const buffers = new Map();

function key(telegramGroupId) {
  return String(telegramGroupId);
}

function prune(list, now) {
  const cutoff = now - WINDOW_MS;
  while (list.length && list[0].at < cutoff) list.shift();
  while (list.length > MAX_PER_GROUP) list.shift();
}

/** Record one group message. Safe to call on every message; never throws. */
function recordMessage(telegramGroupId, { sender, text, at } = {}) {
  try {
    const body = String(text || '').trim();
    if (!body) return;
    const k = key(telegramGroupId);
    const now = Date.now();
    const atMs = Number.isFinite(at) ? at : now;
    const list = buffers.get(k) || [];
    list.push({ at: atMs, sender: sender || 'Unknown', text: body.slice(0, 1000) });
    prune(list, now);
    buffers.set(k, list);
  } catch (_) { /* ignore — buffering is best-effort */ }
}

/**
 * Recent messages for a group within the window (oldest first).
 * @returns {Array<{at:number, sender:string, text:string}>}
 */
function getRecentMessages(telegramGroupId, withinMs = WINDOW_MS) {
  const list = buffers.get(key(telegramGroupId));
  if (!list || !list.length) return [];
  const now = Date.now();
  prune(list, now);
  const cutoff = now - Math.min(withinMs, WINDOW_MS);
  return list.filter((m) => m.at >= cutoff);
}

/** Render the recent messages as a plain transcript for an AI prompt. */
function renderTranscript(telegramGroupId, withinMs = WINDOW_MS) {
  return getRecentMessages(telegramGroupId, withinMs)
    .map((m) => `${m.sender}: ${m.text}`)
    .join('\n');
}

/** Test/maintenance helper. */
function _reset() {
  buffers.clear();
}

module.exports = {
  WINDOW_MS,
  MAX_PER_GROUP,
  recordMessage,
  getRecentMessages,
  renderTranscript,
  _reset,
};
