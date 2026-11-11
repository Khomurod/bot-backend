'use strict';

/**
 * Board ↔ Bitrix questions that say what to do (migration 0102): who may
 * answer them, and the advice shown under each — the recommendation and the
 * actions its buttons stand for. Kept apart from database/boardBitrix.js,
 * which holds the discrepancy queue itself.
 */

const { query } = require('./pool');

const UNDEFINED = new Set(['42P01', '42703']);

/** Telegram user ids, as strings, unique, in order. */
function normaliseIds(values) {
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : String(values || '').split(/[\s,;]+/)) {
    const text = String(value ?? '').trim();
    if (/^\d{3,19}$/.test(text)) seen.add(text);
  }
  return [...seen];
}

/** The people (besides the control channel's operators) whose answers count. */
async function getResponderIds() {
  try {
    const res = await query('SELECT responder_ids FROM board_bitrix_settings WHERE id = 1');
    return normaliseIds((res.rows[0]?.responder_ids || []).map(String));
  } catch (err) {
    if (err && UNDEFINED.has(err.code)) return [];
    throw err;
  }
}

async function setResponderIds(ids, updatedBy = null) {
  const clean = normaliseIds(ids);
  await query(
    `UPDATE board_bitrix_settings
        SET responder_ids = $1::bigint[], updated_at = NOW(), updated_by = $2
      WHERE id = 1`,
    [clean, updatedBy],
  );
  return clean;
}

async function saveAdvice(discrepancyId, advice) {
  await query(
    'UPDATE board_bitrix_discrepancies SET advice_json = $2::jsonb WHERE id = $1',
    [Number(discrepancyId), advice ? JSON.stringify(advice) : null],
  );
}

async function getAdvice(discrepancyId) {
  const res = await query('SELECT advice_json FROM board_bitrix_discrepancies WHERE id = $1', [Number(discrepancyId)]);
  return res.rows[0]?.advice_json || null;
}

module.exports = {
  normaliseIds, getResponderIds, setResponderIds, saveAdvice, getAdvice,
};
