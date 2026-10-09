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
const chatMigration = require('../../services/telegramChatMigration');
const { notify: notifyOps } = require('../../services/notifications/send');
const botUsers = require('../../database/botUsers');
const { handleFuelStopMessage } = require('../../services/fuelStopAlertService');
const { handleDriverGroupStatus } = require('../../services/homeTimeService');
const recentMessageBuffer = require('../../services/recentMessageBuffer');
const { processHomeTimeMessage } = require('../../services/homeTimeRequestService');
const { messageMentionsManagers } = require('../../services/homeTimeRequestConstants');
const { applyAutoReaction } = require('../../services/autoReactionService');
const { ensurePersonForGroup } = require('../../services/identity/personResolver');
const { captureDriverMessage } = require('../../services/retention/chatCapture');
const {
  writeIsDue, forgetWrite, resetCaptureMemory, nameSignature,
  SEEN_REFRESH_MS, BACKFILL_RETRY_MS, GROUP_SEEN_REFRESH_MS,
} = require('./captureWriteMemo');

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
  const key = `driver:${user.id}`;
  if (!writeIsDue(key, nameSignature(user), SEEN_REFRESH_MS)) return;
  try {
    await db.recordDriverSeen(
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null
    );
  } catch (err) {
    forgetWrite(key);
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
    const dispatchKey = `dispatch:${from.id}`;
    if (from.username && writeIsDue(dispatchKey, from.username, BACKFILL_RETRY_MS)) {
      botUsers.backfillDispatchMemberUserId({
        telegramUserId: from.id,
        username: from.username,
      }).catch(() => forgetWrite(dispatchKey));
    }
    if (from.username) {
      // Backfill the stable numeric id onto a driver profile that the admin
      // linked by @username only, the first time that username actually texts
      // in its own group. Scoped to this group, and only fills a NULL id, so it
      // can never mislabel the driver.
      const profileKey = `profile:${group?.id}:${from.id}`;
      if (group?.id && writeIsDue(profileKey, from.username, BACKFILL_RETRY_MS)) {
        db.backfillDriverProfileTelegramUserId({
          groupId: group.id,
          telegramUserId: from.id,
          username: from.username,
        }).catch(() => forgetWrite(profileKey));
      }
    }
  }

  if (group?.id) {
    await Promise.all(users
      .filter((u) => !u.is_bot && (!leftUser || u.id !== leftUser.id))
      .filter((u) => writeIsDue(`member:${group.id}:${u.id}`, nameSignature(u), SEEN_REFRESH_MS))
      .map((u) => db.upsertGroupMember(group.id, u).catch((err) => {
        forgetWrite(`member:${group.id}:${u.id}`);
        console.error('[BOT] Failed to record group member', u.id, err.message);
      })));
    if (leftUser) {
      // Gone now; if they come back, the next message records them again.
      forgetWrite(`member:${group.id}:${leftUser.id}`);
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
/**
 * The move a service message announces, or null. `migrate_to_chat_id`
 * arrives in the OLD chat, `migrate_from_chat_id` in the NEW one.
 */
function migrationOf(ctx) {
  const m = ctx?.message;
  if (m?.migrate_to_chat_id) return { from: ctx.chat.id, to: m.migrate_to_chat_id };
  if (m?.migrate_from_chat_id) return { from: m.migrate_from_chat_id, to: ctx.chat.id };
  return null;
}

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
      // A GROUP UPGRADED TO A SUPERGROUP gets a new id, and this is where it
      // must be followed: FIRST. `migrate_from_chat_id` arrives in the NEW
      // chat, and registering that chat below before following the move
      // inserts a second `groups` row for the same group — the move then finds
      // the new id taken and leaves everything attached to the obsolete row.
      // The move covers every setting naming the group too (the managers'
      // home-time chat once kept a dead id for a week); one audited
      // transaction, and the second side of the same move is a no-op.
      const move = migrationOf(ctx);
      if (move) {
        const summary = await chatMigration.followMigration(move.from, move.to, {
          reason: 'Telegram announced the group was upgraded to a supergroup',
        });
        const said = chatMigration.migrationNotice(summary);
        if (said) notifyOps(said).catch(() => {});
      }
      // Auto-register the group if not already in DB
      let group = null;
      if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
        group = await db.upsertGroup(ctx.chat.id, ctx.chat.title || 'Unknown');
        // The person behind this chat. Resolved once per group per ten minutes
        // (the resolver caches), detached, and never allowed to fail the update:
        // a driver's message must be processed whether or not the identity
        // layer could place them.
        if (group?.group_type === 'driver' && group.active !== false) {
          ensurePersonForGroup(group).catch((err) => {
            console.error('[BOT] ensurePersonForGroup failed:', err.message);
          });
        }
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
      // A group's own "upgraded to a supergroup" service message was already
      // followed by the registration middleware above, BEFORE the group was
      // registered. Nothing else here applies to it.
      if (migrationOf(ctx)) return next();
      const chat = ctx.chat;
      // Only log if it's a group
      if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
        // Auto-react to the sender's message when an admin configured a rule for
        // them. Runs for ANY group (not just driver groups), detached, and never
        // throws — a cached in-memory lookup keeps it off the DB hot path.
        if (ctx.message) {
          applyAutoReaction(bot.telegram, ctx.message).catch((err) => {
            console.error('[BOT] applyAutoReaction failed:', err.message);
          });
        }
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

        // Driver-group messages are recorded to chat_logs ONLY while the owner's
        // switch says so (driver_chat_capture_settings, migration 0065) — and
        // only for driver groups, only text a person wrote. Everything else in
        // every other chat is still not persisted. Load details are not scraped
        // from Telegram either — /status and /load source the active load from
        // the Datatruck OpenAPI (services/datatruckLoadService.js); pinned
        // snapshots above remain the fallback.

        // Bot-visibility diagnostic + home-time tracker for driver groups.
        // Recording "we saw a message" proves the bot can read this group
        // (admin / privacy off), powering the "Bot Group Access" admin view.
        if (group && group.group_type === 'driver' && ctx.message) {
          const seenAtIso = Number.isFinite(ctx.message.date)
            ? new Date(ctx.message.date * 1000).toISOString()
            : new Date().toISOString();
          const seenKey = `seen:${group.id}`;
          if (writeIsDue(seenKey, 'seen', GROUP_SEEN_REFRESH_MS)) {
            db.recordGroupMessageSeen(group.id, seenAtIso).catch(() => forgetWrite(seenKey));
          }
          // Detached and never throws: recording is not what this handler is for.
          captureDriverMessage({ group, message: ctx.message, from: ctx.from }).catch(() => {});
          // Watch for "Status: Home / Ready / Rolling" (deterministic state
          // machine). Returns transition metadata for the conversational flow.
          // Never throws.
          const statusResult = await handleDriverGroupStatus(bot.telegram, group, ctx.message);

          // Fuel Monitor: if this is a gas-station location, start watching the
          // truck and remind the driver when within range. Detached + never
          // throws; cheap pre-filter means most messages exit immediately.
          if (group.active) {
            handleFuelStopMessage(bot.telegram, group, ctx.message).catch((err) => {
              console.error('[BOT] handleFuelStopMessage failed:', err.message);
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

          // Conversational home-time flow: reacts to a real status transition
          // (unplanned home arrival / return to road), an approver tag (request
          // card), a plain-text date answer to an open clarification, or an
          // AI-detected non-exact status / driver-initiated request. Runs detached
          // (it may make a slow AI call), never throws, and is gated by a cheap
          // candidate filter so ordinary chatter never reaches the model.
          processHomeTimeMessage(bot.telegram, group, ctx.message, {
            statusResult,
            mentionsApprover: messageMentionsManagers(ctx.message),
          }).catch((err) => {
            console.error('[BOT] processHomeTimeMessage failed:', err.message);
          });
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
  resetCaptureMemory,
};
