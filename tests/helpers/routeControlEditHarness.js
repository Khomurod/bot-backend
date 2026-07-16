/**
 * Shared harness for the in-place Telegram editor tests
 * (updateDriverGroupRouteMessage). Mocks the driver mention + the DB read/write,
 * and a Telegram client exposing editMessageText/Caption/Media. `editImpl` lets a
 * test force a specific call to throw a Telegram-style error.
 */
const { loadServiceWith } = require('./routeControlHarness');

function loadServiceForEdit({ assignment, screenshot = null, editImpl = {} } = {}) {
  const captured = { edits: [], recordedEdit: null, events: [] };
  const svc = loadServiceWith({
    '../services/driverMention.js': {
      async resolveDriverMentionForGroup() { return { mentionHtml: 'driver', source: 'name', confidence: 'low' }; },
      escapeHtml: (s) => String(s == null ? '' : s),
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return assignment; },
      async getRouteScreenshot() { return screenshot; },
      async recordDriverGroupMessageEdit(id, opts) { captured.recordedEdit = { id, opts }; return { id }; },
      async insertRouteMonitorEvent(e) { captured.events.push(e); return e; },
    },
  });
  const mk = (kind) => async (chatId, messageId, inlineId, a, b) => {
    captured.edits.push({ kind, chatId, messageId, a, b });
    if (editImpl[kind]) return editImpl[kind](chatId, messageId, inlineId, a, b);
    return { message_id: messageId };
  };
  const telegram = {
    editMessageText: mk('text'),
    editMessageCaption: mk('caption'),
    // Media edits go through the RAW callApi so a per-attempt AbortSignal can
    // reach the HTTP layer. Normalize the record to the same shape the wrapper
    // capture used (kind/messageId/a) so existing assertions keep working, plus
    // via/method/signal so tests can prove the abortable path was used.
    async callApi(method, payload, opts) {
      if (method !== 'editMessageMedia') throw new Error(`unexpected callApi method ${method}`);
      const messageId = Number(payload.message_id);
      captured.edits.push({
        kind: 'media', via: 'callApi', method,
        chatId: payload.chat_id, messageId, a: payload.media,
        signal: Boolean(opts && opts.signal), payload,
      });
      if (editImpl.media) return editImpl.media(payload.chat_id, messageId, undefined, payload.media, opts);
      return { message_id: messageId };
    },
  };
  return { svc, telegram, captured };
}

const EDIT_BASE = {
  id: 9, group_id: 7, telegram_group_id: -100900,
  original_url: 'https://maps.google.com/dir?a=1', origin_text: 'A', destination_text: 'B', waypoints: [],
  driver_group_message_sent_at: '2026-07-10T00:00:00Z',
};
const PNG = { file_data: Buffer.from('PNG-BYTES'), mime_type: 'image/png' };
const telegramErr = (code, description) => { const e = new Error(description || 'err'); e.response = { error_code: code, description }; return e; };

// Deterministic retry timing for the resilience tests — no real waiting.
const noRetryWait = { sleep: async () => {}, random: () => 0 };
const socketHangUp = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

module.exports = { loadServiceForEdit, EDIT_BASE, PNG, telegramErr, noRetryWait, socketHangUp };
