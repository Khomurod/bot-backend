'use strict';

/**
 * Safety-approvals settings — single-row store (id = 1).
 *
 * Backs Settings → Safety Approvals. OFF by default and off means off: nothing
 * is read from any chat until an administrator has VALIDATED the recruiting
 * group, named the topic decisions go to, and picked at least one person whose
 * replies count as Safety's. Each of the three is a way to post a wrong
 * "APPROVED", so `enabled` cannot be saved without all three.
 *
 * No environment variable can switch any of this on.
 *
 * As in database/financeSettings.js, only 42P01 (the table does not exist yet)
 * reads as "nothing configured"; any other failure is thrown, so an outage is
 * never mistaken for an administrator having switched the feature off.
 */

const { query } = require('../pool');
const { forgetGroupRows } = require('../groupRowCache');

/**
 * TEN MINUTES. The capture handler asks on every message the bot sees, in every
 * chat. The only writer is `updateSettings` below, which clears the cache, so a
 * change takes effect on the next message.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const UNDEFINED_TABLE = '42P01';

let cache = null;
let cacheExpiresAt = 0;
let generation = 0;

/** A user-input validation failure; the route maps this to HTTP 400. */
class SafetyApprovalSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyApprovalSettingsError';
    this.statusCode = 400;
  }
}

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
  generation += 1;
}

async function getRow() {
  try {
    const { rows } = await query('SELECT * FROM safety_approval_settings WHERE id = 1');
    return rows[0] || null;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

function normaliseChatId(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normaliseTopicId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Telegram user ids, as strings (a bigint does not survive JSON), unique, in order. */
function normaliseUserIds(values) {
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? '').trim();
    if (/^\d{1,19}$/.test(text)) seen.add(text);
  }
  return [...seen];
}

function shape(row) {
  return {
    enabled: Boolean(row?.enabled),
    chatId: normaliseChatId(row?.chat_id),
    chatTitle: row?.chat_title || null,
    chatValidatedAt: row?.chat_validated_at || null,
    topicId: normaliseTopicId(row?.topic_id),
    safetyUserIds: normaliseUserIds(row?.safety_user_ids),
    enabledAt: row?.enabled_at || null,
    // Bitrix deal-stage proposals in the General topic (migration 0076).
    stageProposalsEnabled: Boolean(row?.stage_proposals_enabled),
    updatedAt: row?.updated_at || null,
  };
}

/** Cached read. Throws on a real database failure; see the header. */
async function getSafetyApprovalSettings() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;
  const startedIn = generation;
  const fresh = shape(await getRow());
  if (startedIn === generation) {
    cache = fresh;
    cacheExpiresAt = now + CACHE_TTL_MS;
  }
  return fresh;
}

/** What still stands between these settings and being switched on. */
function missingForEnable(next) {
  const missing = [];
  if (!(next.chat_id && next.chat_validated_at)) missing.push('validate the recruiting group');
  if (!next.topic_id) missing.push('name the approved / not approved topic');
  if (!next.safety_user_ids.length) missing.push('pick at least one Safety person');
  return missing;
}

/**
 * Save. Omitted fields keep their stored value. A different group is a
 * different set of topics, so changing the group without naming a topic
 * clears the topic rather than keeping a number from another chat.
 */
async function updateSafetyApprovalSettings(patch = {}, adminId = null) {
  const current = await getRow();
  const chatId = patch.chatId === undefined ? normaliseChatId(current?.chat_id) : normaliseChatId(patch.chatId);
  const chatChanged = chatId !== normaliseChatId(current?.chat_id);
  const next = {
    // A different group is switched off until it is set up again.
    enabled: patch.enabled === undefined ? Boolean(current?.enabled) && !chatChanged : Boolean(patch.enabled),
    chat_id: chatId,
    chat_title: patch.chatTitle === undefined ? (current?.chat_title ?? null) : (patch.chatTitle || null),
    chat_validated_at: patch.chatValidatedAt === undefined
      ? (chatChanged ? null : (current?.chat_validated_at ?? null))
      : (patch.chatValidatedAt || null),
    topic_id: patch.topicId === undefined
      ? (chatChanged ? null : normaliseTopicId(current?.topic_id))
      : normaliseTopicId(patch.topicId),
    safety_user_ids: patch.safetyUserIds === undefined
      ? normaliseUserIds(current?.safety_user_ids)
      : normaliseUserIds(patch.safetyUserIds),
    stage_proposals_enabled: patch.stageProposalsEnabled === undefined
      ? Boolean(current?.stage_proposals_enabled)
      : Boolean(patch.stageProposalsEnabled),
  };

  const missing = missingForEnable(next);
  if (next.enabled && missing.length) {
    throw new SafetyApprovalSettingsError(`Before switching Safety Approvals on: ${missing.join(', ')}.`);
  }
  const enabledAt = next.enabled ? (current?.enabled_at || new Date()) : (current?.enabled_at || null);

  const { rows } = await query(
    `UPDATE safety_approval_settings
        SET enabled = $1, chat_id = $2, chat_title = $3, chat_validated_at = $4,
            topic_id = $5, safety_user_ids = $6::bigint[], enabled_at = $7,
            updated_at = NOW(), updated_by = $8, stage_proposals_enabled = $9
      WHERE id = 1
      RETURNING *`,
    [
      next.enabled, next.chat_id, next.chat_title, next.chat_validated_at,
      next.topic_id, next.safety_user_ids, enabledAt, adminId, next.stage_proposals_enabled,
    ],
  );
  invalidateCache();
  return shape(rows[0] || null);
}

/**
 * The recruiting group is not a driver's group. Every group the bot sits in is
 * registered as `driver` by default, and driver features — home-time requests,
 * retention, driver broadcasts — act on that. Moving it to `recruitment` (an
 * office group, like the employee group's `employee`) takes it out of all of
 * them. Only a `driver` row is moved: another type was chosen by somebody.
 */
async function markRecruitmentGroup(chatId) {
  const id = normaliseChatId(chatId);
  if (!id || !/^-?\d+$/.test(id)) return 0;
  const result = await query(
    `UPDATE groups SET group_type = 'recruitment'
      WHERE telegram_group_id = $1::bigint AND group_type = 'driver'`,
    [id],
  );
  if (result.rowCount) forgetGroupRows();
  return result.rowCount || 0;
}

module.exports = {
  SafetyApprovalSettingsError,
  getSafetyApprovalSettings,
  updateSafetyApprovalSettings,
  markRecruitmentGroup,
  missingForEnable,
  invalidateCache,
  CACHE_TTL_MS,
  __shapeForTests: shape,
};
