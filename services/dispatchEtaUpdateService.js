const { DateTime } = require('luxon');
const db = require('../database/db');
const { resolveLiveLocationForGroupTitle } = require('./liveLocationResolver');
const { readPinnedLoadContext } = require('./dispatchPinnedContextService');
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

function computeNextRunAt(intervalMinutes) {
  const safe = Number.isInteger(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60;
  return DateTime.utc().plus({ minutes: safe }).toISO();
}

function buildEtaMessage({ group, context, location, source, eta }) {
  const lines = [
    'ETA Update',
    `Group: ${group.group_name || group.telegram_group_id}`,
    context.deliverySummary ? `Delivery: ${context.deliverySummary}` : null,
    `Destination query: ${context.destinationQuery}`,
    location.address ? `Current location: ${location.address}` : `Current location: ${location.latitude}, ${location.longitude}`,
    `Remaining: ${eta.remainingMiles} miles`,
    `ETA: ${formatDuration(eta.etaMinutes)} (around ${eta.etaChicagoLabel} CT)`,
    `Location source: ${source}`,
    location.pingAgeMinutes == null ? null : `Last ping: ${location.pingAgeMinutes} min ago`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function processDispatchEtaJob(job) {
  const nextRunAt = computeNextRunAt(job.interval_minutes);

  try {
    if (!telegramClient) {
      throw new Error('Dispatch ETA Telegram client is not configured.');
    }

    const targetGroups = await db.getGroupsByIds([job.group_id]);
    const group = targetGroups[0];
    if (!group) {
      throw new Error('Driver group is not active or not found.');
    }

    let liveGroupTitle = String(group.group_name || '').trim();
    try {
      const chat = await telegramClient.getChat(group.telegram_group_id);
      const chatTitle = String(chat?.title || '').trim();
      if (chatTitle) {
        liveGroupTitle = chatTitle;
      }
    } catch (err) {
      console.warn(
        `[DISPATCH-ETA] Could not refresh chat title for ${group.telegram_group_id}: ${err.message}`
      );
    }

    const context = await readPinnedLoadContext({
      telegram: telegramClient,
      chatId: group.telegram_group_id,
      groupId: group.id,
      previousSignature: job.last_pinned_signature || '',
      cachedDestinationQuery: job.cached_destination_query || '',
      cachedPickup: job.cached_pickup || '',
      cachedDelivery: job.cached_delivery || '',
    });
    if (!context.destinationQuery) {
      throw new Error('Could not determine delivery destination from pinned message text/media.');
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

    const message = buildEtaMessage({
      group,
      context,
      location: resolved.location,
      source: resolved.source,
      eta: route,
    });

    await telegramClient.sendMessage(group.telegram_group_id, message);

    await db.completeDispatchEtaUpdateSuccess({
      id: job.id,
      nextRunAt,
      lastStatus: 'sent',
      lastPinnedSignature: context.pinnedSignature,
      cachedPickup: context.pickupSummary || '',
      cachedDelivery: context.deliverySummary || '',
      cachedDestinationQuery: context.destinationQuery || '',
      cachedContextJson: {
        source: context.source,
        pinnedMessageId: context.pinnedMessageId || null,
        aiModel: context.aiModel || null,
        updatedAt: new Date().toISOString(),
      },
    });

    console.log(
      `[DISPATCH-ETA] Sent ETA update for group ${group.id} (${group.telegram_group_id}); next run at ${nextRunAt}`
    );
    return { success: true };
  } catch (err) {
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
  processDispatchEtaJob,
  triggerDispatchEtaNowByGroupId,
  startDispatchEtaScheduler,
  stopDispatchEtaScheduler,
  tickDispatchEta,
  computeNextRunAt,
  formatDuration,
};
