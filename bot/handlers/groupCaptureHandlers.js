/**
 * Group + user capture pipeline:
 *   - my_chat_member: activate/deactivate a group when the bot is added/removed;
 *   - middleware: auto-register the group and every user an update touches;
 *   - group message pipeline: supergroup migration, pinned-message snapshots,
 *     bot-visibility diagnostics, home-time status tracking, fuel-stop watch,
 *     the rolling chat buffer, and approver-mention / date-reply detection.
 *
 * Moved verbatim from bot/bot.js. Registration order (relative to the other
 * handler modules) is owned by bot.js::startBot(). None of the modules
 * required here import bot/bot.js, so the require graph stays acyclic.
 */
const db = require('../../database/db');
const botUsers = require('../../database/botUsers');
const { handleFuelStopMessage } = require('../../services/fuelStopAlertService');
const { handleTrailerGroupMessage } = require('../../services/trailerMonitorService');
const { handleDriverGroupStatus } = require('../../services/homeTimeService');
const recentMessageBuffer = require('../../services/recentMessageBuffer');
const {
  handleApproverMention,
  handleHomeTimeDateReply,
} = require('../../services/homeTimeRequestService');
const { messageMentionsApprovers } = require('../../services/homeTimeRequestConstants');

/**
 * Persist a single Telegram user object (from any update field) into `drivers`,
 * refreshing username/first/last each time — a username can appear or change
 * long after we first saw the id. Skips bots and id-less objects. Never throws.
 *
 * Capturing ids as broadly as possible is what makes tg://user?id inline
 * mentions work: Telegram only reliably notifies a user the bot has already
 * "seen", and it can only build the fallback mention once the numeric id is
 * on file. So we upsert from every place a user surfaces — not just senders.
 */
async function captureTelegramUser(user) {
  if (!user || !user.id || user.is_bot) return;
  try {
    await db.upsertDriver(
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null
    );
  } catch (err) {
    console.error('[BOT] Failed to capture user', user.id, err.message);
  }
}

/**
 * Capture every distinct user that appears anywhere in an update: the actor
 * (ctx.from), members added to a group, a user removed from a group, and the
 * author of a replied-to message. De-duplicates by id so we upsert each once.
 *
 * When the update happened inside a registered group (`group` is the DB row),
 * the same users are also recorded in `group_members` — the group linkage that
 * powers the admin "Driver Username" dropdown. This opportunistic capture is
 * the ONLY membership signal available: the Bot API cannot enumerate a group's
 * members (only getChatMember for one known user, getChatAdministrators, and
 * getChatMemberCount), so silent members who never interact will not appear,
 * and a tg://user?id inline mention only reliably notifies a user the bot has
 * seen this way. A user Telegram reports as having left is dropped from the
 * group linkage (their global `drivers` row is kept for mentions elsewhere).
 */
async function captureUsersFromUpdate(ctx, group = null) {
  const seen = new Set();
  const users = [];
  const add = (u) => {
    if (!u || !u.id || seen.has(u.id)) return;
    seen.add(u.id);
    users.push(u);
  };

  add(ctx.from);
  const msg = ctx.message || ctx.editedMessage || ctx.callbackQuery?.message;
  const leftUser = msg?.left_chat_member && !msg.left_chat_member.is_bot
    ? msg.left_chat_member
    : null;
  if (msg) {
    if (Array.isArray(msg.new_chat_members)) msg.new_chat_members.forEach(add);
    add(msg.left_chat_member);
    add(msg.reply_to_message?.from);
  }
  if (ctx.myChatMember?.from) add(ctx.myChatMember.from);

  await Promise.all(users.map(captureTelegramUser));

  // Register the human sender of ANY message in a group into bot_users so the
  // admin Users tab shows everyone the bot sees texting (not only button
  // tappers). Detached + swallowed so it never slows or breaks processing, and
  // opportunistically backfill a matching dispatch member's telegram_user_id.
  const chat = ctx.chat;
  const from = ctx.from;
  const hasMessage = Boolean(ctx.message || ctx.editedMessage);
  if (
    hasMessage && from && from.id != null && !from.is_bot
    && chat && (chat.type === 'group' || chat.type === 'supergroup')
  ) {
    botUsers.recordBotUserSeen({
      telegramUserId: from.id,
      username: from.username || null,
      firstName: from.first_name || null,
      lastName: from.last_name || null,
      languageCode: from.language_code || null,
      isBot: Boolean(from.is_bot),
      groupId: group?.id ?? null,
      chatId: chat.id,
      groupName: chat.title || null,
    }).catch(() => {});
    if (from.username) {
      botUsers.backfillDispatchMemberUserId({
        telegramUserId: from.id,
        username: from.username,
      }).catch(() => {});
      // Backfill the stable numeric id onto a driver profile that the admin
      // linked by @username only, the first time that username actually texts
      // in its own group. Scoped to this group, and only fills a NULL id, so it
      // can never mislabel the driver.
      if (group?.id) {
        db.backfillDriverProfileTelegramUserId({
          groupId: group.id,
          telegramUserId: from.id,
          username: from.username,
        }).catch(() => {});
      }
    }
  }

  if (group?.id) {
    await Promise.all(users
      .filter((u) => !u.is_bot && (!leftUser || u.id !== leftUser.id))
      .map((u) => db.upsertGroupMember(group.id, u).catch((err) => {
        console.error('[BOT] Failed to record group member', u.id, err.message);
      })));
    if (leftUser) {
      await db.removeGroupMember(group.id, leftUser.id).catch((err) => {
        console.error('[BOT] Failed to remove group member', leftUser.id, err.message);
      });
    }
  }
}

/**
 * Register, in this exact order:
 *   1. the my_chat_member group join/leave handler;
 *   2. the user/group capture middleware;
 *   3. the group message pipeline.
 */
function registerGroupCaptureHandlers(bot) {
  // ── 1. Detect when bot is added/removed from a group ──
  bot.on('my_chat_member', async (ctx) => {
    try {
      const chat = ctx.myChatMember.chat;
      const newStatus = ctx.myChatMember.new_chat_member.status;

      if (
        (chat.type === 'group' || chat.type === 'supergroup') &&
        (newStatus === 'member' || newStatus === 'administrator')
      ) {
        // Bot added (or re-added) — provisional active until AI/manual classification
        await db.reactivateGroupOnBotJoin(chat.id, chat.title);
        console.log(`[BOT] Added to group: ${chat.title} (${chat.id})`);
        // Cache the bot's new role so the "Bot Group Access" view updates
        // immediately after a super admin grants admin via the deep link.
        try {
          const grp = await db.getGroupByTelegramId(chat.id);
          if (grp) await db.updateGroupBotAccess(grp.id, newStatus, new Date().toISOString());
        } catch (accessErr) {
          console.warn('[BOT] Could not cache bot role on join:', accessErr.message);
        }
      } else if (
        (chat.type === 'group' || chat.type === 'supergroup') &&
        (newStatus === 'left' || newStatus === 'kicked')
      ) {
        // Bot removed — deactivate so broadcasts skip this group
        await db.deactivateGroup(chat.id);
        console.log(`[BOT] Removed from group: ${chat.title} (${chat.id}) — deactivated`);
      }
    } catch (err) {
      console.error('[BOT] Error handling my_chat_member:', err.message);
    }
  });

  // ── 2. Register drivers AND groups on any interaction ──
  bot.use(async (ctx, next) => {
    try {
      // Auto-register the group if not already in DB
      let group = null;
      if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
        group = await db.upsertGroup(ctx.chat.id, ctx.chat.title || 'Unknown');
      }
      // Register every user this update touched — the sender, plus any
      // new/removed members and the author of a replied-to message — and,
      // inside a group, record them as seen members of that group. This
      // widens id capture beyond message senders so username-less users can
      // still be @-tagged later via a tg://user?id inline mention.
      await captureUsersFromUpdate(ctx, group);
    } catch (err) {
      console.error('[BOT] Error registering driver/group:', err.message);
    }
    return next();
  });

  bot.on('message', async (ctx, next) => {
    try {
      // Catch Telegram group upgrades to Supergroups
      if (ctx.message && ctx.message.migrate_to_chat_id) {
        const oldId = ctx.chat.id;
        const newId = ctx.message.migrate_to_chat_id;
        try {
          await db.query(
            'UPDATE groups SET telegram_group_id = $1 WHERE telegram_group_id = $2',
            [newId, oldId]
          );
          console.log(`[BOT] Migrated group ID from ${oldId} to ${newId}`);
        } catch (e) {
          console.error('[BOT] Failed to migrate group ID:', e.message);
        }
        return next();
      }
      const chat = ctx.chat;
      // Only log if it's a group
      if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
        const group = await db.getGroupByTelegramId(chat.id);
        if (group && ctx.message?.pinned_message?.message_id) {
          const sourceEventDate = Number.isFinite(ctx.message.date)
            ? new Date(ctx.message.date * 1000).toISOString()
            : null;
          await db.upsertGroupPinnedMessageSnapshot({
            groupId: group.id,
            telegramGroupId: chat.id,
            pinnedMessage: ctx.message.pinned_message,
            sourceEventMessageId: ctx.message.message_id || null,
            sourceEventAt: sourceEventDate,
          });
        }

        // General message logging is intentionally disabled: we no longer
        // persist every group message to chat_logs. Load details are no longer
        // scraped from Telegram messages/attachments either — /status and /load
        // now source the active load from the Datatruck OpenAPI (see
        // services/datatruckLoadService.js). Pinned-message snapshots are still
        // captured above so the pinned load context remains available as a
        // fallback when Datatruck is unconfigured or has no matching order.

        // Bot-visibility diagnostic + home-time tracker for driver groups.
        // Recording "we saw a message" proves the bot can read this group
        // (admin / privacy off), powering the "Bot Group Access" admin view.
        if (group && group.group_type === 'driver' && ctx.message) {
          const seenAtIso = Number.isFinite(ctx.message.date)
            ? new Date(ctx.message.date * 1000).toISOString()
            : new Date().toISOString();
          db.recordGroupMessageSeen(group.id, seenAtIso).catch(() => {});
          // Watch for "Status: Home / Ready / Rolling". Never throws.
          await handleDriverGroupStatus(bot.telegram, group, ctx.message);

          // Fuel Monitor: if this is a gas-station location, start watching the
          // truck and remind the driver when within range. Detached + never
          // throws; cheap pre-filter means most messages exit immediately.
          if (group.active) {
            handleFuelStopMessage(bot.telegram, group, ctx.message).catch((err) => {
              console.error('[BOT] handleFuelStopMessage failed:', err.message);
            });

            // Trailer Tracking (Beta): watch for trailer pickup/drop-off messages,
            // register events, and reply/react. Detached + never throws; the
            // service cheap-filters out non-trailer messages immediately.
            handleTrailerGroupMessage(bot.telegram, group, ctx.message).catch((err) => {
              console.error('[BOT] handleTrailerGroupMessage failed:', err.message);
            });
          }

          // Keep a short rolling buffer of this group's chat so the home-time
          // request feature has ~30 min of context for the AI.
          const msgText = ctx.message.text || ctx.message.caption || '';
          if (msgText && !ctx.from?.is_bot) {
            const senderName = ctx.from?.username
              ? `@${ctx.from.username}`
              : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'Driver';
            recentMessageBuffer.recordMessage(group.telegram_group_id, {
              sender: senderName,
              text: msgText,
              at: Number.isFinite(ctx.message.date) ? ctx.message.date * 1000 : Date.now(),
            });
          }

          // A rep tagged an approver → maybe a home-time request. Runs detached
          // (it makes a slow AI call) and never throws; it posts its own card.
          if (messageMentionsApprovers(ctx.message)) {
            handleApproverMention(bot.telegram, group, ctx.message).catch((err) => {
              console.error('[BOT] handleApproverMention failed:', err.message);
            });
          } else {
            // Not an approver tag, but it may be the driver's reply to the bot's
            // "what dates?" question for a request that is awaiting dates. Cheap
            // no-op unless a request is actually waiting. Runs detached.
            handleHomeTimeDateReply(bot.telegram, group, ctx.message).catch((err) => {
              console.error('[BOT] handleHomeTimeDateReply failed:', err.message);
            });
          }
        }
      }
    } catch (err) {
      console.error('[BOT] Error processing group message:', err.message);
    }
    return next();
  });
}

module.exports = {
  captureTelegramUser,
  captureUsersFromUpdate,
  registerGroupCaptureHandlers,
};
