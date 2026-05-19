const { Markup } = require('telegraf');
const config = require('../config/config');
const db = require('../database/db');
const {
  searchDriverGroupsByName,
  formatDriverPickLabel,
  isTestHubGroup,
  buildDriverCandidate,
} = require('../services/driverStatusLookupService');
const { extractUnitFromGroupName } = require('../services/driverGroupTitle');
const { sendDriverStatusSnapshot } = require('../services/dispatchEtaUpdateService');
const session = require('./dispatchStatusLookupSession');

const MAX_INLINE_BUTTONS = 8;
const STATUS_DRV_CALLBACK_PREFIX = 'status_drv_';
const TEST_HUB_NAME_PATTERN = /automatic updating\s*\(test\)/i;

function isDispatchEtaTestHubChatId(chatId) {
  const testId = String(config.dispatchEtaTestGroupId || '').trim();
  return Boolean(testId && String(chatId) === testId);
}

async function isDispatchEtaTestHub(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  if (isDispatchEtaTestHubChatId(chatId)) return true;
  if (config.dispatchEtaTestGroupId) return false;

  const group = await db.getGroupByTelegramId(chatId);
  if (group && TEST_HUB_NAME_PATTERN.test(String(group.group_name || ''))) {
    console.warn(
      '[DISPATCH-STATUS] Test hub matched by group name; set DISPATCH_ETA_TEST_GROUP_ID for reliable routing.'
    );
    return true;
  }
  return false;
}

function isGroupChat(ctx) {
  const chatType = ctx.chat?.type;
  return chatType === 'group' || chatType === 'supergroup';
}

async function resolveDriverGroupById(groupId) {
  const groups = await db.getGroupsByIds([groupId]);
  return groups[0] || null;
}

async function sendStatusForCandidate(ctx, candidate) {
  const driverGroup = await resolveDriverGroupById(candidate.groupId);
  if (!driverGroup) {
    await ctx.reply('That driver group is no longer active. Try /status again.');
    return;
  }

  await ctx.reply('Building status update...');
  await sendDriverStatusSnapshot({
    telegram: ctx.telegram,
    driverGroup,
    destinationChatId: ctx.chat.id,
    targetMode: 'test',
  });
}

function buildPickKeyboard(candidates) {
  const rows = candidates.slice(0, MAX_INLINE_BUTTONS).map((c) => [
    Markup.button.callback(
      formatDriverPickLabel(c).slice(0, 60),
      `${STATUS_DRV_CALLBACK_PREFIX}${c.groupId}`
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

function buildNumberedPickList(candidates) {
  return candidates
    .map((c, i) => `${i + 1}. ${formatDriverPickLabel(c)}`)
    .join('\n');
}

async function presentMultipleMatches(ctx, matches, queryLabel) {
  session.setCandidates(ctx.chat.id, ctx.from.id, matches);
  const list = buildNumberedPickList(matches);
  const overflow = matches.length > MAX_INLINE_BUTTONS
    ? `\n\n(Showing first ${MAX_INLINE_BUTTONS} as buttons; reply with unit # if yours is not listed.)`
    : '';
  await ctx.reply(
    `Found ${matches.length} drivers matching "${queryLabel}". Which one?\n\n${list}${overflow}`,
    buildPickKeyboard(matches)
  );
}

async function searchByUnitNumber(unitDigits) {
  const db = require('../database/db');
  const groups = await db.getAllGroups();
  const filtered = groups.filter((g) => {
    if (isTestHubGroup(g)) return false;
    const unit = extractUnitFromGroupName(g.group_name);
    return unit && String(unit).replace(/^0+/, '') === String(unitDigits).replace(/^0+/, '');
  });
  return filtered.map((g) => buildDriverCandidate(g));
}

async function handleDriverNameQuery(ctx, nameQuery) {
  const queryLabel = String(nameQuery || '').trim();
  if (!queryLabel) {
    await ctx.reply('Please send a driver first name, last name, or full name.');
    return;
  }

  const unitMatch = queryLabel.match(/^#?\s*(\d+)\s*$/i);
  let matches = [];
  if (unitMatch) {
    matches = await searchByUnitNumber(unitMatch[1]);
  } else {
    matches = await searchDriverGroupsByName(queryLabel);
  }

  const active = session.get(ctx.chat.id, ctx.from.id);
  if (active?.step === 'awaiting_pick' && active.candidates?.length && matches.length) {
    const allowedIds = new Set(active.candidates.map((c) => c.groupId));
    const narrowed = matches.filter((m) => allowedIds.has(m.groupId));
    if (narrowed.length === 1) {
      matches = narrowed;
    }
  }
  if (!matches.length) {
    session.clear(ctx.chat.id, ctx.from.id);
    await ctx.reply(`No active driver found for "${queryLabel}". Try another name or /cancel.`);
    return;
  }

  if (matches.length === 1) {
    session.clear(ctx.chat.id, ctx.from.id);
    await sendStatusForCandidate(ctx, matches[0]);
    return;
  }

  await presentMultipleMatches(ctx, matches, queryLabel);
}

async function handleTestHubStatusCommand(ctx) {
  if (!isGroupChat(ctx)) {
    await ctx.reply('Use /status inside the Automatic updating (Test) group.');
    return;
  }

  if (!config.dispatchEtaTestGroupId && !await isDispatchEtaTestHub(ctx)) {
    await ctx.reply(
      'Dispatch test hub is not configured (DISPATCH_ETA_TEST_GROUP_ID). Ask an admin to set it on the server.'
    );
    return;
  }

  if (!await isDispatchEtaTestHub(ctx)) {
    await ctx.reply('This /status flow is only available in the Automatic updating (Test) group.');
    return;
  }

  session.start(ctx.chat.id, ctx.from.id);
  await ctx.reply(
    'Which driver\'s status do you need? Send first name, last name, or full name.\n'
    + 'Send /cancel to stop.'
  );
}

async function handleTestHubCancelCommand(ctx) {
  if (!await isDispatchEtaTestHub(ctx)) return;
  session.clear(ctx.chat.id, ctx.from.id);
  await ctx.reply('Status lookup cancelled.');
}

function registerDispatchStatusLookupHandlers(bot) {
  bot.command('cancel', async (ctx) => {
    try {
      await handleTestHubCancelCommand(ctx);
    } catch (err) {
      console.error('[DISPATCH-STATUS] /cancel failed:', err.message);
    }
  });

  bot.on('text', async (ctx, next) => {
    try {
      if (!await isDispatchEtaTestHub(ctx)) {
        return next();
      }

      const text = String(ctx.message?.text || '').trim();
      if (!text || text.startsWith('/')) {
        return next();
      }

      const active = session.get(ctx.chat.id, ctx.from.id);
      if (!active) {
        return next();
      }

      await handleDriverNameQuery(ctx, text);
    } catch (err) {
      console.error('[DISPATCH-STATUS] text handler failed:', err.message);
      await ctx.reply('Could not look up that driver right now. Try again or send /cancel.');
    }
  });

  bot.action(new RegExp(`^${STATUS_DRV_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    try {
      const chatId = ctx.callbackQuery?.message?.chat?.id;
      if (!isDispatchEtaTestHubChatId(chatId) && !await isDispatchEtaTestHub(ctx)) {
        await ctx.answerCbQuery('This action is only valid in the test hub group.');
        return;
      }

      const groupId = parseInt(ctx.match[1], 10);
      const active = session.get(chatId, ctx.from.id);
      const candidates = active?.candidates || [];
      const candidate = candidates.find((c) => c.groupId === groupId);

      if (!candidate) {
        await ctx.answerCbQuery('Session expired or invalid choice. Send /status to start again.');
        return;
      }

      await ctx.answerCbQuery();
      session.clear(chatId, ctx.from.id);
      await sendStatusForCandidate(ctx, candidate);
    } catch (err) {
      console.error('[DISPATCH-STATUS] pick callback failed:', err.message);
      try {
        await ctx.answerCbQuery('Could not send status. Try /status again.');
      } catch (answerErr) {
        console.warn('[DISPATCH-STATUS] answerCbQuery failed:', answerErr.message);
      }
    }
  });

  console.log('[DISPATCH-STATUS] Test hub /status lookup handlers registered.');
}

module.exports = {
  isDispatchEtaTestHub,
  handleTestHubStatusCommand,
  registerDispatchStatusLookupHandlers,
};
