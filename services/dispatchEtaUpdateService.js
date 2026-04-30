const { DateTime } = require('luxon');
const db = require('../database/db');
const config = require('../config/config');
const { resolveLiveLocationForGroupTitle } = require('./liveLocationResolver');
const { readLoadContextWithFallbacks, NO_CURRENT_LOAD_INFO_MESSAGE } = require('./dispatchPinnedContextService');
const { calculateEtaToDestination } = require('./etaRoutingService');

const ETA_POLL_INTERVAL_MS = 30 * 1000;
const ETA_MAX_BATCH = 10;

let schedulerStopped = false;
let schedulerTimer = null;
let tickRunning = false;
let telegramClient = null;

function configureDispatchEtaTelegram(telegram) {
  telegramClient = telegram || null;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function hasAnyLoadContext(context) {
  return Boolean(
    normalizeText(context?.pickupSummary)
    || normalizeText(context?.deliverySummary)
    || normalizeText(context?.destinationQuery)
  );
}

function formatDuration(minutes) {
  const safe = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function formatSpeedValue(value) {
  if (!Number.isFinite(value)) return '0mph';
  const rounded = Number(value.toFixed(1));
  return `${rounded}mph`;
}

function computeNextRunAt(intervalMinutes) {
  const safe = Number.isInteger(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60;
  return DateTime.utc().plus({ minutes: safe }).toISO();
}

function buildEtaMessage({ context, location, source, eta, etaError = '' }) {
  const destination = normalizeText(context?.deliverySummary)
    || normalizeText(context?.destinationQuery)
    || 'Unavailable';

  const hasCoords = Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude);
  const currentLocation = normalizeText(location?.address)
    || (hasCoords ? `${location.latitude}, ${location.longitude}` : 'Unavailable');

  const pingText = location?.pingAgeMinutes == null ? 'unknown' : `${location.pingAgeMinutes} min ago`;
  const speedText = Number.isFinite(location?.speedMilesPerHour)
    ? formatSpeedValue(location.speedMilesPerHour)
    : 'Unavailable';
  const milesLeftText = Number.isFinite(eta?.remainingMiles)
    ? `${eta.remainingMiles} miles`
    : 'Unavailable';
  const etaText = Number.isFinite(eta?.etaMinutes) && normalizeText(eta?.etaChicagoLabel)
    ? `${formatDuration(eta.etaMinutes)} (around ${eta.etaChicagoLabel} CT${eta?.approximate ? ', approximate' : ''})`
    : `Unavailable${normalizeText(etaError) ? ` - ${normalizeText(etaError)}` : ''}`;

  const detailLines = [
    `📍 <b>Delivery location</b>: ${escapeHtml(destination)}`,
    `🚛 <b>Current location</b>: ${escapeHtml(currentLocation)}`,
    `🛣️ <b>Miles left</b>: ${escapeHtml(milesLeftText)}`,
    `🏎️ <b>Speed</b>: ${escapeHtml(speedText)}`,
    `⏱️ <b>ETA</b>: ${escapeHtml(etaText)}`,
    `🛰️ <b>Location source</b>: ${escapeHtml(normalizeText(source) || 'Unavailable')}`,
    `🕒 <b>Last ping</b>: ${escapeHtml(pingText)}`,
  ].join('\n');

  return `⚡ <b>Current update</b>:\n<blockquote expandable>${detailLines}</blockquote>`;
}

function toPlainStatusText(htmlMessage) {
  return decodeHtmlEntities(
    String(htmlMessage || '')
      .replace(/<blockquote\s+expandable>/gi, '\n')
      .replace(/<\/blockquote>/gi, '')
      .replace(/<\/?b>/gi, '')
      .replace(/<\/?[^>]+>/g, '')
  ).trim();
}

async function sendEtaMessageWithFallback(telegram, chatId, htmlMessage) {
  try {
    await telegram.sendMessage(chatId, htmlMessage, { parse_mode: 'HTML' });
  } catch (err) {
    const message = String(err?.message || '').toLowerCase();
    if (!message.includes("can't parse entities")) {
      throw err;
    }
    await telegram.sendMessage(chatId, toPlainStatusText(htmlMessage));
  }
}

async function resolveDispatchEtaSnapshotForGroup({
  telegram,
  group,
  previousSignature = '',
  cachedDestinationQuery = '',
  cachedPickup = '',
  cachedDelivery = '',
}) {
  let liveGroupTitle = String(group.group_name || '').trim();
  try {
    const chat = await telegram.getChat(group.telegram_group_id);
    const chatTitle = String(chat?.title || '').trim();
    if (chatTitle) {
      liveGroupTitle = chatTitle;
    }
  } catch (err) {
    console.warn(
      `[DISPATCH-ETA] Could not refresh chat title for ${group.telegram_group_id}: ${err.message}`
    );
  }

  let context = null;
  let contextError = '';
  try {
    context = await readLoadContextWithFallbacks({
      telegram,
      chatId: group.telegram_group_id,
      groupId: group.id,
      previousSignature,
      cachedDestinationQuery,
      cachedPickup,
      cachedDelivery,
    });
  } catch (err) {
    contextError = String(err?.message || err || '');
    context = {
      pickupSummary: normalizeText(cachedPickup),
      deliverySummary: normalizeText(cachedDelivery),
      destinationQuery: normalizeText(cachedDestinationQuery),
      source: 'cache',
      pinnedSignature: normalizeText(previousSignature),
      pinnedMessageId: null,
      aiModel: '',
      fallbackLevel: 0,
      fallbackAttempts: ['cache-only'],
      loadInfoComplete: false,
    };
    if (!hasAnyLoadContext(context)) {
      const noInfo = new Error(NO_CURRENT_LOAD_INFO_MESSAGE);
      noInfo.code = 'LOAD_CONTEXT_NOT_FOUND';
      noInfo.cause = err;
      throw noInfo;
    }
  }

  let resolved = null;
  let locationError = '';
  try {
    resolved = await resolveLiveLocationForGroupTitle(liveGroupTitle);
  } catch (err) {
    locationError = String(err?.message || err || '');
  }

  let route = null;
  let etaError = '';
  if (resolved?.location && normalizeText(context.destinationQuery)) {
    try {
      route = await calculateEtaToDestination({
        currentLatitude: resolved.location.latitude,
        currentLongitude: resolved.location.longitude,
        destinationQuery: context.destinationQuery,
      });
      if (!route) {
        etaError = 'Could not calculate route ETA with current destination/location.';
      }
    } catch (err) {
      etaError = String(err?.message || 'Could not calculate route ETA with current destination/location.');
    }
  } else if (!normalizeText(context.destinationQuery)) {
    etaError = 'No delivery destination found in current load context.';
  } else {
    etaError = 'No live location available from providers right now.';
  }

  return {
    context,
    location: resolved?.location || {},
    source: resolved?.source || 'Unavailable',
    eta: route,
    etaError,
    contextError,
    locationError,
    liveGroupTitle,
  };
}

async function processDispatchEtaJob(job) {
  const nextRunAt = computeNextRunAt(job.interval_minutes);
  let targetTelegramGroupId = null;

  try {
    if (!telegramClient) {
      throw new Error('Dispatch ETA Telegram client is not configured.');
    }

    const targetGroups = await db.getGroupsByIds([job.group_id]);
    const group = targetGroups[0];
    if (!group) {
      throw new Error('Driver group is not active or not found.');
    }
    const targetMode = String(job?.target_mode || 'driver').trim().toLowerCase() === 'test'
      ? 'test'
      : 'driver';
    targetTelegramGroupId = targetMode === 'test'
      ? String(config.dispatchEtaTestGroupId || '').trim()
      : String(group.telegram_group_id || '').trim();
    if (!targetTelegramGroupId) {
      throw new Error(
        targetMode === 'test'
          ? 'DISPATCH_ETA_TEST_GROUP_ID is not configured.'
          : 'Driver group telegram chat id is missing.'
      );
    }

    const snapshot = await resolveDispatchEtaSnapshotForGroup({
      telegram: telegramClient,
      group,
      previousSignature: job.last_pinned_signature || '',
      cachedDestinationQuery: job.cached_destination_query || '',
      cachedPickup: job.cached_pickup || '',
      cachedDelivery: job.cached_delivery || '',
    });

    const message = buildEtaMessage({
      context: snapshot.context,
      location: snapshot.location,
      source: snapshot.source,
      eta: snapshot.eta,
      etaError: snapshot.etaError,
    });

    await sendEtaMessageWithFallback(telegramClient, targetTelegramGroupId, message);

    await db.completeDispatchEtaUpdateSuccess({
      id: job.id,
      nextRunAt,
      lastStatus: snapshot.eta ? 'sent' : 'partial_sent',
      lastPinnedSignature: snapshot.context.pinnedSignature || job.last_pinned_signature || null,
      cachedPickup: snapshot.context.pickupSummary || '',
      cachedDelivery: snapshot.context.deliverySummary || '',
      cachedDestinationQuery: snapshot.context.destinationQuery || '',
      cachedContextJson: {
        source: snapshot.context.source,
        pinnedMessageId: snapshot.context.pinnedMessageId || null,
        aiModel: snapshot.context.aiModel || null,
        etaError: snapshot.etaError || '',
        contextError: snapshot.contextError || '',
        locationError: snapshot.locationError || '',
        updatedAt: new Date().toISOString(),
      },
    });

    console.log(
      `[DISPATCH-ETA] Sent ETA update for group ${group.id} to ${targetTelegramGroupId} (mode=${targetMode}); next run at ${nextRunAt}`
    );
    return { success: true, partial: !snapshot.eta };
  } catch (err) {
    if (err?.code === 'LOAD_CONTEXT_NOT_FOUND') {
      try {
        if (targetTelegramGroupId) {
          await telegramClient.sendMessage(targetTelegramGroupId, NO_CURRENT_LOAD_INFO_MESSAGE);
        }
      } catch (sendErr) {
        console.warn('[DISPATCH-ETA] Could not send no-load-info message:', sendErr.message);
      }

      await db.completeDispatchEtaUpdateSuccess({
        id: job.id,
        nextRunAt,
        lastStatus: 'no_load_info',
        lastPinnedSignature: null,
        cachedPickup: '',
        cachedDelivery: '',
        cachedDestinationQuery: '',
        cachedContextJson: {
          source: 'fallback-miss',
          updatedAt: new Date().toISOString(),
          note: NO_CURRENT_LOAD_INFO_MESSAGE,
        },
      });
      return { success: true, noLoadInfo: true };
    }

    await db.completeDispatchEtaUpdateFailure({
      id: job.id,
      nextRunAt,
      errorMessage: err.message,
    });
    console.error(`[DISPATCH-ETA] Failed ETA update for group ${job.group_id}:`, err.message);
    return { success: false, error: err.message };
  }
}

async function triggerDispatchEtaNowByGroupId(groupId) {
  const claim = await db.claimDispatchEtaUpdateByGroupId(groupId);
  if (!claim) {
    return {
      triggered: false,
      reason: 'not_enabled_or_already_processing',
    };
  }
  const result = await processDispatchEtaJob(claim);
  return {
    triggered: true,
    ...result,
  };
}

async function tickDispatchEta() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const due = await db.claimDueDispatchEtaUpdates(ETA_MAX_BATCH);
    if (!due.length) return;

    console.log(`[DISPATCH-ETA] Processing ${due.length} due ETA job(s)`);
    for (const job of due) {
      if (schedulerStopped) break;
      await processDispatchEtaJob(job);
    }
  } catch (err) {
    console.error('[DISPATCH-ETA] Tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function scheduleNextTick() {
  if (schedulerStopped) return;
  schedulerTimer = setTimeout(async () => {
    await tickDispatchEta();
    scheduleNextTick();
  }, ETA_POLL_INTERVAL_MS);
}

function startDispatchEtaScheduler() {
  schedulerStopped = false;
  console.log(`[DISPATCH-ETA] Service started; polling every ${ETA_POLL_INTERVAL_MS / 1000}s`);
  (async () => {
    await tickDispatchEta();
    scheduleNextTick();
  })();
}

function stopDispatchEtaScheduler() {
  schedulerStopped = true;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  console.log('[DISPATCH-ETA] Service stopped.');
}

module.exports = {
  buildEtaMessage,
  configureDispatchEtaTelegram,
  NO_CURRENT_LOAD_INFO_MESSAGE,
  resolveDispatchEtaSnapshotForGroup,
  processDispatchEtaJob,
  triggerDispatchEtaNowByGroupId,
  startDispatchEtaScheduler,
  stopDispatchEtaScheduler,
  tickDispatchEta,
  computeNextRunAt,
  formatDuration,
  toPlainStatusText,
  sendEtaMessageWithFallback,
};
