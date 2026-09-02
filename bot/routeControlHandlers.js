/**
 * Route Control — Telegram handlers.
 *
 * Detects a Google Maps route link sent in a driver group by an authorized
 * dispatcher and creates/updates the Route Control assignment for that group,
 * reusing the same parse + assign logic as the admin panel
 * (routeControlService.parseRouteLink / assignRoute). A location pin is not a
 * route (see services/routeMessageDetection). When a group already has an
 * active route, the bot asks an authorized user to confirm Replace vs Ignore
 * with inline buttons.
 *
 * Requires only DB modules + the route service (never bot.js) to avoid a
 * circular dependency, mirroring homeTime/mileage handlers.
 */
const db = require('../database/db');
const ra = require('../database/raiseApproval');
const rc = require('../database/routeControl');
const routeControl = require('../services/routeControlService');
const { safeSend } = require('../services/telegramHtml');
const { normalizeTelegramUsername, formatTelegramUsername } = require('../lib/telegram/telegramUsername');
const { isGlobalRouteAdmin } = require('../lib/routeControl/routeControlConstants');
const {
  detectRouteAssignment,
  extractGoogleMapsLinks,
  shouldReplyOnUnparseable,
  authorizeRouteAssigner,
} = require('../services/routeMessageDetection');

const MSG = {
  success: '✅ Route Control: assigned route saved. I will monitor this route.',
  geometryPending: '✅ Route saved, but Google Maps API is not configured or route geometry '
    + 'is pending. Monitoring will start after geometry is computed.',
  unparseable: '⚠️ I could not read this route link. Please send a full Google Maps directions '
    + 'link with origin and destination, or assign it manually from Admin → Route Control.',
  apiError: '⚠️ Route Control: I could not compute this route right now (Google Maps error). '
    + 'Please try again shortly, or assign it manually from Admin → Route Control.',
  unauthorized: '⚠️ Route Control: only authorized dispatch/admin users can assign a route.',
  alreadyActive: '⚠️ This driver already has an active route. Replace it with the new route?',
  replaced: '✅ Route Control: route replaced. I will monitor the new route.',
  ignored: '👍 Route Control: kept the current route. The new route was ignored.',
  expired: '⚠️ This route confirmation expired. Please send the route link again.',
};

/**
 * Structured, MASKED one-line log for a Route Control event. Never logs the
 * full URL (short links carry opaque tokens); only the host + classified kind.
 * @param {string} event  one of ignored-fuel | ignored-place | candidate-detected
 *   | assignment-accepted | assignment-rejected-unauthorized | parse-failed | api-error
 * @param {{ chatId?:(number|string), url?:string, kind?:string, reason?:string }} fields
 */
function logRouteEvent(event, { chatId, url, kind, reason } = {}) {
  let host = null;
  if (url) {
    try { host = new URL(url).hostname; } catch (_) { host = null; }
  }
  const parts = [`[ROUTE-CONTROL] event=${event}`];
  if (chatId != null) parts.push(`chat=${chatId}`);
  if (host) parts.push(`host=${host}`);
  if (kind) parts.push(`kind=${kind}`);
  if (reason) parts.push(`reason=${reason}`);
  console.log(parts.join(' '));
}

// ── In-memory rate limit + dedupe + pending confirmations (per-process) ──
const ONE_HOUR_MS = 60 * 60 * 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_ASSIGNS_PER_HOUR_PER_CHAT = 20;

const actionTimestampsByChat = new Map(); // chatId -> number[]
const recentUrlsByChat = new Map(); // chatId -> Map(url -> ts)
const pendingConfirmations = new Map(); // `${chatId}:${messageId}` -> { ..., expiresAt }

function now() { return Date.now(); }

function isRateLimited(chatId) {
  const arr = (actionTimestampsByChat.get(chatId) || []).filter((t) => now() - t < ONE_HOUR_MS);
  actionTimestampsByChat.set(chatId, arr);
  return arr.length >= MAX_ASSIGNS_PER_HOUR_PER_CHAT;
}
function recordAction(chatId) {
  const arr = actionTimestampsByChat.get(chatId) || [];
  arr.push(now());
  actionTimestampsByChat.set(chatId, arr);
}
function wasRecentlyProcessed(chatId, url) {
  const map = recentUrlsByChat.get(chatId);
  if (!map) return false;
  const ts = map.get(url);
  if (ts == null) return false;
  if (now() - ts > DEDUP_TTL_MS) { map.delete(url); return false; }
  return true;
}
function recordProcessed(chatId, url) {
  let map = recentUrlsByChat.get(chatId);
  if (!map) { map = new Map(); recentUrlsByChat.set(chatId, map); }
  map.set(url, now());
}
function setPending(key, value) {
  pendingConfirmations.set(key, { ...value, expiresAt: now() + PENDING_TTL_MS });
}
function getPending(key) {
  const p = pendingConfirmations.get(key);
  if (!p) return null;
  if (now() > p.expiresAt) { pendingConfirmations.delete(key); return null; }
  return p;
}
function clearPending(key) { pendingConfirmations.delete(key); }

function senderLabel(user) {
  return formatTelegramUsername(user?.username)
    || [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim()
    || (user?.id != null ? `id:${user.id}` : 'someone');
}

function replyToChat(ctx, text, extra = {}) {
  const chatId = ctx.chat?.id;
  const replyTo = ctx.message?.message_id;
  return safeSend(() => ctx.telegram.sendMessage(chatId, text, {
    disable_web_page_preview: true,
    ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    ...extra,
  }));
}

/** Resolve whether `user` may assign a route for driver group `groupId`. */
async function resolveAuthorization(user, groupId) {
  const username = normalizeTelegramUsername(user?.username);
  const [byUsername, byUserId] = await Promise.all([
    username ? ra.findActiveTeamMembersByUsername(username) : Promise.resolve([]),
    user?.id != null ? ra.findActiveTeamMembersByUserId(Number(user.id)) : Promise.resolve([]),
  ]);
  const memberTeamIds = [...new Set([...byUsername, ...byUserId].map((m) => m.team_id))];
  const groupTeamIds = await ra.getActiveTeamIdsForGroup(groupId);
  return authorizeRouteAssigner({
    isGlobalAdmin: isGlobalRouteAdmin(user),
    memberTeamIds,
    groupTeamIds,
  });
}

/** Core message handler. Returns a small result object (used by tests/logging). */
async function handleRouteMessage(ctx) {
  const chat = ctx.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return { handled: false };
  if (ctx.from?.is_bot) return { handled: false };
  const text = ctx.message?.text || ctx.message?.caption || '';
  if (!text) return { handled: false };

  const detection = detectRouteAssignment(text);
  if (!detection.isCandidate) {
    // Masked logs for the two "we saw a link but deliberately did nothing" cases
    // so the separation from Fuel Monitoring is auditable without leaking URLs.
    if (detection.reason === 'fuel_or_non_route') {
      logRouteEvent('ignored-fuel', { chatId: chat.id, reason: detection.reason });
    } else if (extractGoogleMapsLinks(text).length) {
      logRouteEvent('ignored-place', { chatId: chat.id, reason: 'no_route_keyword' });
    }
    return { handled: false };
  }

  const group = await db.getGroupByTelegramId(chat.id);
  if (!group || group.group_type !== 'driver' || !group.active) return { handled: false };

  logRouteEvent('candidate-detected', { chatId: chat.id, url: detection.url, kind: detection.linkKind });

  const messageId = ctx.message?.message_id;
  // Restart-safe dedupe: this exact message already produced an assignment.
  if (await rc.findRouteAssignmentByTelegramMessage(chat.id, messageId)) {
    return { handled: false, reason: 'dedup_persistent' };
  }
  if (wasRecentlyProcessed(chat.id, detection.url)) return { handled: false, reason: 'dedup_memory' };
  if (isRateLimited(chat.id)) return { handled: false, reason: 'rate_limited' };

  const auth = await resolveAuthorization(ctx.from || {}, group.id);
  if (!auth.authorized) {
    logRouteEvent('assignment-rejected-unauthorized', {
      chatId: chat.id, kind: detection.linkKind, reason: auth.reason,
    });
    await replyToChat(ctx, MSG.unauthorized);
    return { handled: true, reason: `unauthorized:${auth.reason}` };
  }

  recordProcessed(chat.id, detection.url);
  recordAction(chat.id);

  // Validate/parse the link before touching state.
  try {
    await routeControl.parseRouteLink(detection.url);
  } catch (err) {
    logRouteEvent('parse-failed', {
      chatId: chat.id, url: detection.url, kind: detection.linkKind, reason: err.code || 'unparseable',
    });
    if (shouldReplyOnUnparseable(detection)) await replyToChat(ctx, MSG.unparseable);
    return { handled: true, reason: 'unparseable' };
  }

  const assignedBy = senderLabel(ctx.from);
  const existing = await rc.getActiveRouteAssignmentByGroupId(group.id);
  if (existing) {
    const key = `${chat.id}:${messageId}`;
    setPending(key, {
      groupId: group.id, url: detection.url, assignedBy,
      assignedByUserId: ctx.from?.id != null ? Number(ctx.from.id) : null,
      chatId: chat.id, messageId,
    });
    await replyToChat(ctx, MSG.alreadyActive, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Replace active route', callback_data: `rc:replace:${chat.id}:${messageId}` },
          { text: 'Ignore', callback_data: `rc:ignore:${chat.id}:${messageId}` },
        ]],
      },
    });
    return { handled: true, reason: 'needs_confirmation' };
  }

  let result;
  try {
    result = await routeControl.assignRoute({
      groupId: group.id,
      url: detection.url,
      assignedBy,
      source: 'telegram',
      assignedByUserId: ctx.from?.id != null ? Number(ctx.from.id) : null,
      telegramChatId: chat.id,
      telegramMessageId: messageId,
    });
  } catch (err) {
    // Google API (or other assignment) failure — reply once, never crash, and
    // never store a geometry-less route row (assignRoute computes before insert).
    logRouteEvent('api-error', {
      chatId: chat.id, kind: detection.linkKind, reason: err.code || 'assign_failed',
    });
    await replyToChat(ctx, MSG.apiError);
    return { handled: true, reason: 'api_error' };
  }
  logRouteEvent('assignment-accepted', {
    chatId: chat.id, kind: detection.linkKind,
    reason: result.geometryPending ? 'geometry_pending' : 'computed',
  });
  await replyToChat(ctx, result.geometryPending ? MSG.geometryPending : MSG.success);
  return { handled: true, reason: result.geometryPending ? 'assigned_pending' : 'assigned' };
}

function editOrReply(ctx, text) {
  return safeSend(() => ctx.editMessageText(text)).catch(() => {
    const chatId = ctx.callbackQuery?.message?.chat?.id || ctx.chat?.id;
    return safeSend(() => ctx.telegram.sendMessage(chatId, text, { disable_web_page_preview: true }));
  });
}

/** Handle the Replace / Ignore confirmation buttons. */
async function handleConfirmationAction(ctx) {
  const action = ctx.match[1];
  const chatId = ctx.match[2];
  const messageId = ctx.match[3];
  const key = `${chatId}:${messageId}`;
  try { await ctx.answerCbQuery(); } catch (_) { /* best effort */ }

  const pending = getPending(key);
  if (!pending) { await editOrReply(ctx, MSG.expired); return { handled: true, reason: 'expired' }; }

  const auth = await resolveAuthorization(ctx.from || {}, pending.groupId);
  if (!auth.authorized) {
    try { await ctx.answerCbQuery('Only authorized dispatch/admin users can decide this.', { show_alert: true }); } catch (_) { /* ignore */ }
    return { handled: true, reason: 'unauthorized' };
  }

  if (action === 'ignore') {
    const existing = await rc.getActiveRouteAssignmentByGroupId(pending.groupId);
    if (existing) {
      await rc.insertRouteMonitorEvent({
        assignmentId: existing.id,
        eventType: 'ignored',
        detail: `new Telegram route from ${pending.assignedBy} ignored; kept current route`,
      });
    }
    clearPending(key);
    await editOrReply(ctx, MSG.ignored);
    return { handled: true, reason: 'ignored' };
  }

  // Replace: cancel the current active route(s), then assign the new one.
  await routeControl.cancelActiveRoutesForGroup(pending.groupId, {
    detail: `Replaced by new Telegram route from ${pending.assignedBy}`,
  });
  let result;
  try {
    result = await routeControl.assignRoute({
      groupId: pending.groupId,
      url: pending.url,
      assignedBy: pending.assignedBy,
      source: 'telegram',
      assignedByUserId: pending.assignedByUserId,
      telegramChatId: pending.chatId,
      telegramMessageId: pending.messageId,
    });
  } catch (err) {
    clearPending(key);
    await editOrReply(ctx, MSG.unparseable);
    return { handled: true, reason: 'replace_unparseable' };
  }
  clearPending(key);
  await editOrReply(ctx, result.geometryPending ? MSG.geometryPending : MSG.replaced);
  return { handled: true, reason: result.geometryPending ? 'replaced_pending' : 'replaced' };
}

function registerRouteControlHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      await handleRouteMessage(ctx);
    } catch (err) {
      console.error('[ROUTE-CONTROL] Message handler error:', err.message);
    }
    return next();
  });

  bot.action(/^rc:(replace|ignore):(-?\d+):(\d+)$/, async (ctx) => {
    try {
      await handleConfirmationAction(ctx);
    } catch (err) {
      console.error('[ROUTE-CONTROL] Confirmation action error:', err.message);
      try { await ctx.answerCbQuery('Something went wrong.'); } catch (_) { /* ignore */ }
    }
  });

  console.log('[ROUTE-CONTROL] Telegram route handlers registered.');
}

module.exports = {
  registerRouteControlHandlers,
  handleRouteMessage,
  handleConfirmationAction,
  resolveAuthorization,
  MSG,
  // exported for tests
  _internal: { setPending, getPending, clearPending, pendingConfirmations, recentUrlsByChat, actionTimestampsByChat },
};
