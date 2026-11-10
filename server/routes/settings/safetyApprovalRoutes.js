'use strict';

/**
 * Safety Approvals — admin API (Settings → Safety Approvals).
 *
 * Where an administrator points the bot at the recruiting group, names the
 * "approved / not approved" topic, and picks the people whose replies count as
 * Safety's — and names the Bitrix topic, where everything the stage proposals
 * write goes (each topic is saved, then proven with a test message).
 * `enabled` cannot be saved without the first three
 * (database/safetyApprovals/settings.js), and the group is VALIDATED here —
 * the bot is asked whether it can reach the chat — before it is stored.
 *
 * The bot must also SEE every message in the group: a bot in privacy mode
 * that is not an administrator receives only commands and replies to itself,
 * and would never see a recruiter's post. Validation says so plainly.
 */

const express = require('express');
const settingsStore = require('../../../database/safetyApprovals/settings');
const reviews = require('../../../database/safetyApprovals/reviews');
const { listRecentProposals } = require('../../../database/hiringStages/proposals');
const { listRecentRecords } = require('../../../database/hiringStages/crmRecords');
const { listGroupMembers } = require('../../../database/groupMembers');
const { getGroupByTelegramId } = require('../../../database/groups');
const { checkChatId } = require('../../../services/telegramChatIdCheck');
const { parseTopicReference } = require('../../../lib/safetyApprovals/announcement');
const { sendFailure } = require('../../middleware/failureResponse');

const LOG = { logPrefix: '[SETTINGS API]' };
const CANNOT_SEE = 'The bot can reach this group but cannot see its messages. Make the bot an admin of the '
  + 'group (or turn its privacy mode off in BotFather), then validate again.';

/** Can the bot read every message in this chat? `null` when it cannot be asked. */
async function botSeesEverything(telegram, chatId) {
  if (!telegram || typeof telegram.getMe !== 'function') return { known: false };
  try {
    const me = await telegram.getMe();
    if (me?.can_read_all_group_messages) return { known: true, ok: true, how: 'privacy mode is off' };
    const member = await telegram.getChatMember(chatId, me.id);
    const admin = ['administrator', 'creator'].includes(member?.status);
    return admin ? { known: true, ok: true, how: 'the bot is an admin' } : { known: true, ok: false };
  } catch (_) {
    return { known: false };
  }
}

/** The people seen in the group, for the Safety picker. Names only, no messages. */
async function membersOf(chatId) {
  if (!chatId) return [];
  const group = await getGroupByTelegramId(chatId).catch(() => null);
  if (!group?.id) return [];
  const rows = await listGroupMembers(group.id);
  return rows.slice(0, 300).map((r) => ({
    id: String(r.telegram_user_id),
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
    username: r.username || null,
    lastSeenAt: r.last_seen_at || null,
  }));
}

function shapeReview(r) {
  return {
    id: r.id,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError,
    decisions: r.outcome?.decisions || [],
    posted: r.outcome?.posted || [],
    reason: r.outcome?.reason || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** A Bitrix stage proposal, for the list under its switch. A name and stages; no message text. */
function shapeProposal(p) {
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    driverName: p.driverName,
    dealTitle: p.dealTitle,
    fromStageName: p.fromStageName,
    toStageName: p.toStageName,
    decidedByName: p.decidedByName,
    lastError: p.lastError,
    createdAt: p.createdAt,
  };
}

/** A pasted topic link or number → `{topicId}`, or `{error, field}`. */
async function topicFromBody(value, patch, field) {
  const raw = String(value ?? '').trim();
  if (!raw) return { topicId: null };
  const parsed = parseTopicReference(raw);
  if (parsed.error) return { error: parsed.error, field };
  const chatId = patch.chatId !== undefined
    ? patch.chatId
    : (await settingsStore.getSafetyApprovalSettings()).chatId;
  if (parsed.chatId && chatId && parsed.chatId !== chatId) {
    return { error: 'That link is to a topic in a different group from the recruiting group.', field };
  }
  return { topicId: parsed.topicId };
}

/** Post a short message in one of the two topics, to prove the bot may write there. */
async function testPost(res, telegram, topicKey, text) {
  try {
    const settings = await settingsStore.getSafetyApprovalSettings();
    if (!settings.chatId || !settings[topicKey]) {
      return res.status(400).json({ error: 'Save the recruiting group and the topic first.' });
    }
    if (!telegram) return res.status(503).json({ error: 'The bot is not running.' });
    await telegram.sendMessage(settings.chatId, text, { message_thread_id: settings[topicKey] });
    return res.json({ ok: true });
  } catch (err) {
    return res.json({ ok: false, message: `Telegram refused: ${String(err?.description || err?.message || err)}` });
  }
}

/** A contact + deal the bot created (or could not), for the list under the switch. No phone. */
function shapeRecord(r) {
  return {
    id: r.id,
    status: r.status,
    driverName: r.driverName,
    dealId: r.dealId,
    contactReused: r.contactReused,
    dealReused: r.dealReused,
    lastError: r.lastError,
    updatedAt: r.updatedAt,
  };
}

function createSafetyApprovalSettingsRouter({ authMiddleware, telegram }) {
  const router = express.Router();

  router.get('/safety-approvals', authMiddleware, async (req, res) => {
    try {
      const settings = await settingsStore.getSafetyApprovalSettings();
      const [members, recent, proposals, created] = await Promise.all([
        membersOf(settings.chatId),
        reviews.listRecentReviews(20),
        listRecentProposals(15),
        listRecentRecords(10),
      ]);
      res.json({
        settings,
        members,
        recent: recent.map(shapeReview),
        proposals: proposals.map(shapeProposal),
        crmRecords: created.map(shapeRecord),
      });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to read the Safety Approvals settings', ...LOG });
    }
  });

  router.post('/safety-approvals/validate-chat', authMiddleware, async (req, res) => {
    try {
      const result = await checkChatId(req.body?.chatId, { telegram, getGroupByTelegramId });
      if (!result.ok) {
        return res.json({
          ok: false, status: result.status, message: result.message, suggestion: result.suggestion ?? null,
        });
      }
      const sees = await botSeesEverything(telegram, result.chatId);
      return res.json({
        ok: true,
        status: result.status,
        chatId: result.chatId,
        chatTitle: result.groupName ?? null,
        seesEverything: sees.known ? sees.ok : null,
        message: sees.known && !sees.ok ? CANNOT_SEE : null,
      });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to validate the recruiting group', ...LOG });
    }
  });

  router.put('/safety-approvals', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
      if (Array.isArray(body.safetyUserIds)) patch.safetyUserIds = body.safetyUserIds;
      if (body.stageProposalsEnabled !== undefined) patch.stageProposalsEnabled = Boolean(body.stageProposalsEnabled);

      if (body.chatId !== undefined) {
        const raw = String(body.chatId ?? '').trim();
        if (!raw) {
          Object.assign(patch, { chatId: null, chatTitle: null, chatValidatedAt: null, enabled: false });
        } else {
          const result = await checkChatId(raw, { telegram, getGroupByTelegramId });
          if (!result.ok) {
            return res.status(400).json({
              error: result.message, status: result.status, field: 'chatId', suggestion: result.suggestion ?? null,
            });
          }
          // A group the bot cannot read is not a validated group: it would
          // never see a post, and the switch would turn on to do nothing.
          const sees = await botSeesEverything(telegram, result.chatId);
          if (sees.known && !sees.ok) return res.status(400).json({ error: CANNOT_SEE, field: 'chatId' });
          patch.chatId = result.chatId;
          patch.chatTitle = result.groupName ?? null;
          patch.chatValidatedAt = new Date();
        }
      }

      for (const [field, key] of [['topic', 'topicId'], ['bitrixTopic', 'bitrixTopicId']]) {
        if (body[field] === undefined) continue;
        // eslint-disable-next-line no-await-in-loop
        const topic = await topicFromBody(body[field], patch, field);
        if (topic.error) return res.status(400).json(topic);
        patch[key] = topic.topicId;
      }

      const saved = await settingsStore.updateSafetyApprovalSettings(patch, req.admin?.id ?? null);
      if (saved.chatId) await settingsStore.markRecruitmentGroup(saved.chatId).catch(() => 0);
      return res.json(saved);
    } catch (err) {
      if (err instanceof settingsStore.SafetyApprovalSettingsError) {
        return res.status(400).json({ error: err.message });
      }
      return sendFailure(res, err, { message: 'Failed to save the Safety Approvals settings', ...LOG });
    }
  });

  router.post('/safety-approvals/test-post', authMiddleware, (req, res) => testPost(res, telegram, 'topicId',
    '✅ Safety Approvals is connected. Safety\'s decisions will be posted in this topic.'));

  router.post('/safety-approvals/test-bitrix-topic', authMiddleware, (req, res) => testPost(res, telegram, 'bitrixTopicId',
    '✅ Bitrix is connected. Stage proposals, deals created in Bitrix and Bitrix errors will be posted in this topic.'));

  return router;
}

module.exports = { createSafetyApprovalSettingsRouter, botSeesEverything };
