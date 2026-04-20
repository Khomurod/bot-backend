// services/aiAnnotationService.js
//
// Stage A of the AI Insights pipeline.
//
// Reads rows from chat_logs that have no matching chat_message_annotations,
// classifies them via Yandex (batched JSON call), and inserts the results.
//
// Role attribution is inferred per-message from context ONLY — no user_roles
// table. The caller later aggregates per-sender consensus from many messages.
//
// Public surface:
//   - annotateChatLogs(logs, opts) -> writes rows, returns count annotated
//   - ensureAnnotationsForRange(groupIds, daysBack) -> finds unannotated
//     chat_logs in scope and annotates them
//   - parseAnnotationBatchResponse(text) -> tested pure helper
//   - buildAnnotationPrompt(batch) -> tested pure helper
//   - VALID_INTENTS / VALID_ROLES
//
const db = require('../database/db');
const { callYandexRaw } = require('./yandexClient');

const MODEL_VERSION = 'yandex-v1-annotator';
const BATCH_SIZE = 12; // keeps per-call prompt comfortably under Yandex lite context
const MAX_MESSAGE_CHARS = 1200; // per message, truncate so one ranter can't eat the batch

const VALID_ROLES = ['driver', 'dispatcher', 'admin', 'unknown'];
const VALID_INTENTS = [
  'status_update',
  'home_time_request',
  'complaint',
  'question',
  'acknowledgement',
  'quit_signal',
  'breakdown',
  'accident',
  'eta',
  'location',
  'document',
  'social',
  'offtopic',
  'praise',
  'conflict',
  'no_signal',
];
const VALID_LANGUAGES = ['en', 'ru', 'uz', 'other'];

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function sanitizeForPrompt(text) {
  // Neutralize anything that looks like a fence or meta instruction inside
  // the transcript so it can't steer the classifier.
  return String(text || '')
    .replace(/<\/?driver_transcript>/gi, '')
    .replace(/<\/?model_draft>/gi, '')
    .replace(/```/g, '` ` `')
    .slice(0, MAX_MESSAGE_CHARS);
}

function buildAnnotationPrompt(batch) {
  // Batch is an array of { id, group_name, sender_name, created_at, message_text }
  const header = [
    'You are classifying chat messages from Telegram groups used by a US trucking company.',
    'Each group contains a mix of drivers, dispatchers, and office admins.',
    'Infer the ROLE of the sender from context only — drivers give short status updates, ETAs, arrivals, breakdowns, home-time requests, complaints about pay/dispatch; dispatchers give load assignments, ask for status, push timelines, coordinate drops; admins post policy, payroll, HR, announcements.',
    '',
    'Return ONLY a JSON array, one object per input message, in the same order, with keys:',
    '  id                 (integer, echo input id)',
    '  role               ("driver"|"dispatcher"|"admin"|"unknown")',
    '  role_confidence    (0-100)',
    '  intent             (one of: ' + VALID_INTENTS.join(', ') + ')',
    '  sentiment          (-2..2, integer; -2 very negative, 0 neutral, +2 very positive)',
    '  urgency            (0..3; 0=none, 1=low, 2=high, 3=emergency)',
    '  is_acknowledgement (true if the message is only "ok", "copy", "10-4", "👍" or equivalent in any language)',
    '  toxic              (true if hostile, insulting, or threatening)',
    '  language           ("en"|"ru"|"uz"|"other")',
    '  entities           (object; include only keys that are clearly stated: home_date YYYY-MM-DD, city, load_id, dollars, hours)',
    '',
    'Rules:',
    '- Output JSON ONLY, no prose, no markdown, no code fences.',
    '- If the message is empty or unparseable, set intent="no_signal", sentiment=0, urgency=0, role="unknown", role_confidence=0.',
    '- Never invent entities that are not explicitly present.',
    '',
    'Messages:',
  ].join('\n');

  const lines = batch.map((m) => {
    const ts = m.created_at ? new Date(m.created_at).toISOString() : '';
    const sender = String(m.sender_name || 'Unknown').replace(/\s+/g, ' ').trim();
    const group = String(m.group_name || 'Unknown').replace(/\s+/g, ' ').trim();
    const text = sanitizeForPrompt(m.message_text).replace(/\s+/g, ' ').trim();
    return `#${m.id} [${ts}] [${group}] ${sender}: ${text}`;
  });

  return `${header}\n${lines.join('\n')}`;
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function extractJsonArray(text) {
  const cleaned = stripCodeFences(text);
  // Fast path: whole response is a valid JSON array.
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) { /* fall through */ }
  // Recovery: first [ ... ] block.
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* fall through */ }
  }
  return null;
}

function normalizeAnnotation(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number.isFinite(Number(raw.id)) ? Number(raw.id) : fallbackId;
  if (!Number.isFinite(id)) return null;

  const role = VALID_ROLES.includes(String(raw.role)) ? String(raw.role) : 'unknown';
  const intent = VALID_INTENTS.includes(String(raw.intent)) ? String(raw.intent) : 'no_signal';
  const language = VALID_LANGUAGES.includes(String(raw.language)) ? String(raw.language) : 'other';

  let entities = raw.entities;
  if (entities && typeof entities === 'object' && !Array.isArray(entities)) {
    // Keep only known keys to avoid prompt-injected payload.
    const keep = {};
    ['home_date', 'city', 'load_id', 'dollars', 'hours'].forEach((k) => {
      if (entities[k] !== undefined && entities[k] !== null && entities[k] !== '') {
        keep[k] = typeof entities[k] === 'string' ? entities[k].slice(0, 120) : entities[k];
      }
    });
    entities = Object.keys(keep).length ? keep : null;
  } else {
    entities = null;
  }

  return {
    id,
    role,
    role_confidence: clampInt(raw.role_confidence, 0, 100, 0),
    intent,
    sentiment: clampInt(raw.sentiment, -2, 2, 0),
    urgency: clampInt(raw.urgency, 0, 3, 0),
    is_acknowledgement: Boolean(raw.is_acknowledgement),
    toxic: Boolean(raw.toxic),
    language,
    entities,
  };
}

/**
 * Pure parser — tested directly. Returns array of normalized annotations.
 * Input: raw yandex text, array of batch inputs (for id fallback alignment).
 */
function parseAnnotationBatchResponse(responseText, batch) {
  const arr = extractJsonArray(responseText) || [];
  const byId = new Map();
  arr.forEach((row, index) => {
    const fallbackId = batch[index] ? batch[index].id : undefined;
    const norm = normalizeAnnotation(row, fallbackId);
    if (norm) byId.set(norm.id, norm);
  });
  // Ensure we preserve input order and fill gaps with "no_signal" defaults.
  return batch.map((input) => {
    const found = byId.get(input.id);
    if (found) return found;
    return {
      id: input.id,
      role: 'unknown',
      role_confidence: 0,
      intent: 'no_signal',
      sentiment: 0,
      urgency: 0,
      is_acknowledgement: false,
      toxic: false,
      language: 'other',
      entities: null,
    };
  });
}

async function annotateBatch(batch) {
  const prompt = buildAnnotationPrompt(batch);
  const systemText = 'You are a strict classifier. Return JSON only. Never include prose or code fences. If unsure, use "unknown" / "no_signal" and confidence 0.';
  const response = await callYandexRaw(prompt, {
    systemText,
    temperature: 0.1,
    maxTokens: Math.min(4000, 250 + batch.length * 180),
  });
  return parseAnnotationBatchResponse(response, batch);
}

async function persistAnnotations(annotations) {
  if (!annotations.length) return 0;

  // Single multi-row UPSERT. chat_log_id is PK, so re-annotations overwrite.
  const values = [];
  const placeholders = [];
  annotations.forEach((a, i) => {
    const o = i * 11;
    placeholders.push(
      `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}::jsonb, $${o + 11})`
    );
    values.push(
      a.id,
      a.language,
      a.intent,
      a.sentiment,
      a.urgency,
      a.role,
      a.role_confidence,
      a.is_acknowledgement,
      a.toxic,
      a.entities ? JSON.stringify(a.entities) : null,
      MODEL_VERSION
    );
  });

  const sql = `
    INSERT INTO chat_message_annotations
      (chat_log_id, language, intent, sentiment, urgency, role_guess, role_confidence,
       is_acknowledgement, toxic, entities_json, model_version)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (chat_log_id) DO UPDATE SET
      language = EXCLUDED.language,
      intent = EXCLUDED.intent,
      sentiment = EXCLUDED.sentiment,
      urgency = EXCLUDED.urgency,
      role_guess = EXCLUDED.role_guess,
      role_confidence = EXCLUDED.role_confidence,
      is_acknowledgement = EXCLUDED.is_acknowledgement,
      toxic = EXCLUDED.toxic,
      entities_json = EXCLUDED.entities_json,
      model_version = EXCLUDED.model_version,
      annotated_at = NOW()
  `;
  const res = await db.query(sql, values);
  return res.rowCount || annotations.length;
}

async function annotateChatLogs(logs, opts = {}) {
  if (!Array.isArray(logs) || logs.length === 0) return 0;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  let totalWritten = 0;
  for (let i = 0; i < logs.length; i += BATCH_SIZE) {
    const batch = logs.slice(i, i + BATCH_SIZE).map((log) => ({
      id: log.id,
      group_name: log.group_name,
      sender_name: log.sender_name,
      message_text: log.message_text,
      created_at: log.created_at,
    }));
    try {
      const annotations = await annotateBatch(batch);
      const written = await persistAnnotations(annotations);
      totalWritten += written;
      onProgress({ done: Math.min(i + BATCH_SIZE, logs.length), total: logs.length, written });
    } catch (err) {
      console.error('[ANNOTATE] Batch failed, skipping:', err.message);
      onProgress({ done: Math.min(i + BATCH_SIZE, logs.length), total: logs.length, error: err.message });
    }
  }
  return totalWritten;
}

/**
 * Find chat_logs in the given window that have no matching annotation row
 * and classify them. Returns { found, annotated }.
 */
async function ensureAnnotationsForRange({ daysBack = 7, groupIds = null, onProgress } = {}) {
  const params = [daysBack];
  let groupClause = '';
  if (Array.isArray(groupIds) && groupIds.length > 0) {
    params.push(groupIds);
    groupClause = `AND cl.group_id = ANY($${params.length}::int[])`;
  }
  const sql = `
    SELECT cl.id, cl.group_id, cl.sender_name, cl.message_text, cl.created_at,
           g.group_name
      FROM chat_logs cl
      JOIN groups g ON g.id = cl.group_id
      LEFT JOIN chat_message_annotations a ON a.chat_log_id = cl.id
     WHERE cl.created_at >= NOW() - ($1 || ' days')::INTERVAL
       ${groupClause}
       AND a.chat_log_id IS NULL
     ORDER BY cl.created_at ASC
  `;
  const { rows } = await db.query(sql, params);
  const annotated = await annotateChatLogs(rows, { onProgress });
  return { found: rows.length, annotated };
}

let isAnnotating = false;

function startBackgroundAnnotator() {
  console.log('[ANNOTATOR] Starting background annotator loop (120s interval).');
  setInterval(async () => {
    if (isAnnotating) return;
    isAnnotating = true;
    try {
      // console.log('[ANNOTATOR] Background loop: checking for unannotated messages...');
      const result = await ensureAnnotationsForRange({ daysBack: 14 });
      if (result.annotated > 0) {
        console.log(`[ANNOTATOR] Background loop: found ${result.found}, annotated ${result.annotated}.`);
      }
    } catch (err) {
      console.error('[ANNOTATOR] Background loop error:', err.message);
    } finally {
      isAnnotating = false;
    }
  }, 120000);
}

module.exports = {
  MODEL_VERSION,
  BATCH_SIZE,
  VALID_ROLES,
  VALID_INTENTS,
  VALID_LANGUAGES,
  annotateChatLogs,
  ensureAnnotationsForRange,
  startBackgroundAnnotator,
  // pure helpers exported for tests
  buildAnnotationPrompt,
  parseAnnotationBatchResponse,
  sanitizeForPrompt,
  stripCodeFences,
  extractJsonArray,
  normalizeAnnotation,
};
