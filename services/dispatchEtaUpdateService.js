const { DateTime } = require('luxon');
const db = require('../database/db');
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

function formatSpeedValue(value) {
  if (!Number.isFinite(value)) return '0mph';
  const rounded = Number(value.toFixed(1));
  return `${rounded}mph`;
}

function computeNextRunAt(intervalMinutes) {
  const safe = Number.isInteger(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60;
  return DateTime.utc().plus({ minutes: safe }).toISO();
}

function buildEtaMessage({ group, context, location, source, eta }) {
  const destination = context.deliverySummary || context.destinationQuery || '';
  const currentLocation = location.address
    ? location.address
    : `${location.latitude}, ${location.longitude}`;
  const pingText = location.pingAgeMinutes == null ? 'unknown' : `${location.pingAgeMinutes} min ago`;
  const detailLines = [
    `📍 <b>Delivery location</b>: ${escapeHtml(destination)}`,
    `🚛 <b>Current location</b>: ${escapeHtml(currentLocation)}`,
    `🛣️ <b>Miles left</b>: ${eta.remainingMiles} miles`,
    `🏎️ <b>Speed</b>: ${escapeHtml(formatSpeedValue(location.speedMilesPerHour))}`,
    `⏱️ <b>ETA</b>: ${escapeHtml(formatDuration(eta.etaMinutes))} (around ${escapeHtml(eta.etaChicagoLabel)} CT)`,
    `🛰️ <b>Location source</b>: ${escapeHtml(source)}`,
    `🕒 <b>Last ping</b>: ${escapeHtml(pingText)}`,
  ].join('\n');

  return `⚡ <b>Current update</b>:\n<blockquote expandable>${detailLines}</blockquote>`;
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

  const context = await readLoadContextWithFallbacks({
    telegram,
    chatId: group.telegram_group_id,
    groupId: group.id,
    previousSignature,
    cachedDestinationQuery,
    cachedPickup,
    cachedDelivery,
  });
  if (!context.destinationQuery) {
    const noInfo = new Error(NO_CURRENT_LOAD_INFO_MESSAGE);
    noInfo.code = 'LOAD_CONTEXT_NOT_FOUND';
    throw noInfo;
  }

  const resolved = await resolveLiveLocationForGroupTitle(liveGroupTitle);
  const route = await calculateEtaToDestination({
    currentLatitude: resolved.location.latitude,
    currentLongitude: resolved.location.longitude,
    destinationQuery: context.destinationQuery,
  });
  if (!route) {
    throw new Error('Could not calculate route ETA to destination.');
  }

  return {
    context,
    location: resolved.location,
    source: resolved.source,
    eta: route,
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
    targetTelegramGroupId = group.telegram_group_id;

    const snapshot = await resolveDispatchEtaSnapshotForGroup({
      telegram: telegramClient,
      group,
      previousSignature: job.last_pinned_signature || '',
      cachedDestinationQuery: job.cached_destination_query || '',
      cachedPickup: job.cached_pickup || '',
      cachedDelivery: job.cached_delivery || '',
    });

    const message = buildEtaMessage({
      group,
      context: snapshot.context,
      location: snapshot.location,
      source: snapshot.source,
      eta: snapshot.eta,
    });

    await telegramClient.sendMessage(group.telegram_group_id, message, { parse_mode: 'HTML' });

    await db.completeDispatchEtaUpdateSuccess({
      id: job.id,
      nextRunAt,
      lastStatus: 'sent',
      lastPinnedSignature: snapshot.context.pinnedSignature || null,
      cachedPickup: snapshot.context.pickupSummary || '',
      cachedDelivery: snapshot.context.deliverySummary || '',
      cachedDestinationQuery: snapshot.context.destinationQuery || '',
      cachedContextJson: {
        source: snapshot.context.source,
        pinnedMessageId: snapshot.context.pinnedMessageId || null,
        aiModel: snapshot.context.aiModel || null,
        updatedAt: new Date().toISOString(),
      },
    });

    console.log(
      `[DISPATCH-ETA] Sent ETA update for group ${group.id} (${group.telegram_group_id}); next run at ${nextRunAt}`
    );
    return { success: true };
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
};
