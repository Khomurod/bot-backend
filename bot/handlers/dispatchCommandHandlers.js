/**
 * Dispatcher group commands: /load, /location, /update, and /status.
 *
 * Moved verbatim from bot/bot.js. /status is registered separately
 * (registerStatusCommand) because bot.js must register the anonymous-feedback
 * and test-hub status-lookup handlers BETWEEN the other commands and /status —
 * their private-chat text handling has to take priority.
 */
const db = require('../../database/db');
const { readLoadContextWithFallbacks } = require('../../services/dispatchPinnedContextService');
const { resolveLiveLocationForGroupTitle } = require('../../services/liveLocationResolver');
const {
  buildLocationSummaryLines,
  buildStrictMismatchBlockMessage,
  isLocationDriverNameStrict,
} = require('../../services/driverGroupTitle');
const {
  triggerDispatchEtaNowByGroupId,
  NO_CURRENT_LOAD_INFO_MESSAGE,
} = require('../../services/dispatchEtaUpdateService');
const { runStatusSnapshotDetached } = require('../../services/statusSnapshotDetached');
const {
  isDispatchEtaTestHub,
  handleTestHubStatusCommand,
} = require('../dispatchStatusLookupHandlers');

// Disabled leftover debug instrumentation (see bot/bot.js). No-op kept so the
// moved call sites stay valid.
function debugLog() {}

function registerDispatchCommands(bot) {
  // Summarize resolved load context (stored recent loads → pin → chat history). No GPS.
  bot.command('load', async (ctx) => {
    try {
      // #region agent log
      debugLog('bot/bot.js:load', '/load handler entered', {
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
      }, 'C');
      // #endregion
      const chatType = ctx.chat?.type;
      if (chatType !== 'group' && chatType !== 'supergroup') {
        await ctx.reply('Use /load inside a driver group chat.');
        return;
      }

      const group = await db.getGroupByTelegramId(ctx.chat.id);
      // #region agent log
      debugLog('bot/bot.js:load', '/load group lookup', {
        chatId: ctx.chat?.id,
        found: Boolean(group),
        groupType: group?.group_type || null,
        active: group?.active ?? null,
        groupId: group?.id ?? null,
      }, 'B');
      // #endregion
      if (!group || group.group_type !== 'driver' || !group.active) {
        await ctx.reply('This command works only in active driver groups.');
        return;
      }

      const context = await readLoadContextWithFallbacks({
        telegram: bot.telegram,
        chatId: ctx.chat.id,
        group,
        groupId: group.id,
      });

      const lines = [];
      // When Datatruck is the source, lead with the load number + status it now
      // provides (the shared current-load service). Other fallback sources have
      // no structured load id, so these lines are simply omitted for them.
      if (context.loadIdentifier) lines.push(`Load #: ${context.loadIdentifier}`);
      if (context.status) lines.push(`Status: ${context.status}`);
      lines.push(
        `Resolved from: ${context.source}`,
        `Pickup: ${context.pickupSummary || '—'}`,
        `Delivery: ${context.deliverySummary || '—'}`,
        `Destination (routing): ${context.destinationQuery || '—'}`,
      );
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      if (err?.code === 'LOAD_CONTEXT_NOT_FOUND') {
        await ctx.reply(NO_CURRENT_LOAD_INFO_MESSAGE);
        return;
      }
      console.error('[BOT] /load failed:', err.message);
      await ctx.reply('Could not resolve load context right now.');
    }
  });

  // Dispatcher helper: post live truck location for this group's unit number.
  bot.command('location', async (ctx) => {
    try {
      // #region agent log
      debugLog('bot/bot.js:location', '/location handler entered', {
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
        chatTitle: ctx.chat?.title || '',
      }, 'C');
      // #endregion
      const chatType = ctx.chat?.type;
      if (chatType !== 'group' && chatType !== 'supergroup') {
        await ctx.reply('Use /location inside a driver group chat.');
        return;
      }

      const groupTitle = ctx.chat?.title || '';
      let resolved = null;
      try {
        resolved = await resolveLiveLocationForGroupTitle(groupTitle);
      } catch (err) {
        if (err.code === 'UNIT_NOT_FOUND_IN_GROUP_TITLE') {
          await ctx.reply('Could not find a unit number in this group title.');
          return;
        }
        if (err.code === 'AMBIGUOUS_UNIT_MATCH') {
          const who = err.assignedDriverName ? ` for this driver (${err.assignedDriverName})` : '';
          const candidates = Array.isArray(err.candidates) && err.candidates.length
            ? `\nVehicles sharing unit ${err.unitNumber}: ${err.candidates.join(', ')}.` : '';
          await ctx.reply(
            `⚠️ Multiple trucks share unit ${err.unitNumber} and I can't tell which one is this truck${who}. `
            + 'To avoid sending the wrong location I did not post one.'
            + candidates
            + '\nPlease fix the duplicate unit number, or rename the vehicle in Samsara to match the driver.'
          );
          return;
        }
        console.error('[BOT] /location provider chain failed:', err.message);
        await ctx.reply('Could not fetch live location from Samsara, Factor ELD, or Leader ELD right now.');
        return;
      }
      const { location, source } = resolved;

      if (location.driverNameMismatch && isLocationDriverNameStrict()) {
        await ctx.reply(buildStrictMismatchBlockMessage(location));
        return;
      }

      await ctx.replyWithLocation(location.latitude, location.longitude);
      await ctx.reply(buildLocationSummaryLines({ location, source }).join('\n'));
      // #region agent log
      debugLog('bot/bot.js:location', '/location succeeded', {
        chatId: ctx.chat?.id,
        source,
        hasCoords: Boolean(location?.latitude && location?.longitude),
      }, 'D');
      // #endregion
    } catch (err) {
      // #region agent log
      debugLog('bot/bot.js:location', '/location failed', {
        chatId: ctx.chat?.id,
        error: err?.message || String(err),
        code: err?.code || null,
      }, 'D');
      // #endregion
      console.error('[BOT] /location failed:', err.message);
      await ctx.reply('Could not fetch live location right now. Please try again in a minute.');
    }
  });

  // Dispatcher ETA helper: manually trigger immediate ETA update if feature is enabled.
  bot.command('update', async (ctx) => {
    try {
      const chatType = ctx.chat?.type;
      if (chatType !== 'group' && chatType !== 'supergroup') {
        await ctx.reply('Use /update inside a driver group chat.');
        return;
      }

      const group = await db.getGroupByTelegramId(ctx.chat.id);
      if (!group || group.group_type !== 'driver' || !group.active) {
        await ctx.reply('This command works only in active driver groups.');
        return;
      }

      const setting = await db.getDispatchEtaSettingByGroupId(group.id);
      if (!setting || !setting.enabled) {
        await ctx.reply('ETA updates are currently turned off for this group.');
        return;
      }

      await ctx.reply('Running ETA update now...');
      const result = await triggerDispatchEtaNowByGroupId(group.id);
      if (result?.success) {
        await ctx.reply('ETA update sent.');
        return;
      }

      if (result?.triggered === false && result?.reason === 'not_enabled_or_already_processing') {
        await ctx.reply('ETA update is already running. Please wait a moment.');
        return;
      }

      const detail = result?.error || 'Unknown error';
      await ctx.reply(`ETA update failed: ${detail}`);
    } catch (err) {
      console.error('[BOT] /update failed:', err.message);
      await ctx.reply('Could not run ETA update right now. Please try again shortly.');
    }
  });
}

// Dispatcher status helper: always available, even if auto updates are disabled.
function registerStatusCommand(bot) {
  bot.command('status', async (ctx) => {
    try {
      // #region agent log
      debugLog('bot/bot.js:status', '/status handler entered', {
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
      }, 'C');
      // #endregion
      const chatType = ctx.chat?.type;
      if (chatType !== 'group' && chatType !== 'supergroup') {
        await ctx.reply('Use /status inside a driver group chat.');
        return;
      }

      const testHub = await isDispatchEtaTestHub(ctx);
      // #region agent log
      debugLog('bot/bot.js:status', '/status test hub check', {
        chatId: ctx.chat?.id,
        testHub,
      }, 'E');
      // #endregion
      if (testHub) {
        await handleTestHubStatusCommand(ctx);
        return;
      }

      const group = await db.getGroupByTelegramId(ctx.chat.id);
      // #region agent log
      debugLog('bot/bot.js:status', '/status group lookup', {
        chatId: ctx.chat?.id,
        found: Boolean(group),
        groupType: group?.group_type || null,
        active: group?.active ?? null,
        groupId: group?.id ?? null,
      }, 'B');
      // #endregion
      if (!group || group.group_type !== 'driver' || !group.active) {
        await ctx.reply('This command works only in active driver groups.');
        return;
      }

      await ctx.reply('Building status update...');
      const telegram = ctx.telegram;
      const destinationChatId = ctx.chat.id;
      const driverGroup = group;

      runStatusSnapshotDetached({
        telegram,
        driverGroup,
        destinationChatId,
        targetMode: 'driver',
        interactive: true,
      }).catch(() => {});
      // #region agent log
      debugLog('bot/bot.js:status', '/status snapshot detached', {
        chatId: ctx.chat?.id,
        groupId: group.id,
      }, 'D');
      // #endregion
    } catch (err) {
      // #region agent log
      debugLog('bot/bot.js:status', '/status failed', {
        chatId: ctx.chat?.id,
        error: err?.message || String(err),
        code: err?.code || null,
      }, 'D');
      // #endregion
      console.error('[BOT] /status failed:', err.message);
      await ctx.reply('Could not build current status right now. Please try again shortly.');
    }
  });
}

module.exports = { registerDispatchCommands, registerStatusCommand };
