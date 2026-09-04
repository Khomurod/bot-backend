/**
 * ALERT side of the Fuel Monitor: deciding a truck is near, and replying.
 *
 * `processFuelAlert` is the whole business behaviour — compare live truck GPS to
 * the station, and when it is inside `radius_miles` reply to the ORIGINAL
 * message tagging the driver. Rows are claimed with FOR UPDATE SKIP LOCKED by
 * the caller, so two overlapping ticks can never remind twice.
 *
 * Split out of services/fuelStopAlertService.js, which re-exports these.
 */
const db = require('../../database/db');
const { resolveLiveLocationForGroupTitle } = require('../liveLocationResolver');
const { haversineMiles } = require('../etaRoutingService');
const { callGeminiText } = require('../geminiClient');
const { DEFAULT_RADIUS_MILES, RETRY_GAP_MIN } = require('./constants');
const {
  normalizeText, escapeHtml, buildDriverDisplayName, milesLabel, minutesFromNowIso,
  computeNextCheck,
} = require('./textRules');
const { buildDriverTag } = require('./driverTag');
const { getFuelStopTelegram } = require('./telegramClient');

async function buildReminderBody({ stationName, distanceMiles }) {
  const miles = milesLabel(distanceMiles);
  const station = normalizeText(stationName);
  const fallback = station
    ? `you're about ${miles} miles from your assigned fuel stop (${station}). Please fuel up there as instructed.`
    : `you're about ${miles} miles from your assigned fuel stop. Please fuel up there as instructed.`;

  try {
    const { text } = await callGeminiText({
      systemText:
        'You write very short, friendly dispatch reminders for truck drivers in English.',
      userText:
        `Write ONE short reminder (max 25 words) telling the driver they are approaching their `
        + `assigned fuel stop and must fuel there. It is about ${miles} miles ahead`
        + `${station ? ` at ${station}` : ''}. `
        + 'Do NOT include any @mention, the driver\'s name, emojis, or quotes. Plain text, one sentence.',
      maxOutputTokens: 80,
    });
    const body = normalizeText(text).replace(/^["'@\-\s]+/, '').replace(/\s+/g, ' ');
    if (body) return body;
  } catch (err) {
    console.warn('[FUEL-ALERT] AI wording failed, using fallback:', err.message);
  }
  return fallback;
}

async function resolveLiveTitle(telegram, row) {
  let title = normalizeText(row.group_name);
  try {
    const chat = await telegram.getChat(row.telegram_group_id);
    const chatTitle = normalizeText(chat?.title);
    if (chatTitle) title = chatTitle;
  } catch (err) {
    // Keep the stored title; unit number is usually present there too.
    console.warn(`[FUEL-ALERT] Could not refresh chat title for ${row.telegram_group_id}: ${err.message}`);
  }
  return title;
}

async function processFuelAlert(telegram, row) {
  try {
    const title = await resolveLiveTitle(telegram, row);

    let resolved = null;
    try {
      resolved = await resolveLiveLocationForGroupTitle(title);
    } catch (err) {
      // No live location yet (offline truck, unit # not parseable, provider
      // hiccup). Re-check soon; the 24h expiry is the backstop.
      await db.rescheduleFuelStopAlert(row.id, {
        nextCheckAt: minutesFromNowIso(RETRY_GAP_MIN),
        error: err.message,
      });
      return { notified: false, reason: 'no_location' };
    }

    const loc = resolved?.location || {};
    if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
      await db.rescheduleFuelStopAlert(row.id, {
        nextCheckAt: minutesFromNowIso(RETRY_GAP_MIN),
        error: 'No GPS coordinates',
      });
      return { notified: false, reason: 'no_coords' };
    }

    const distanceMiles = haversineMiles(
      loc.latitude,
      loc.longitude,
      Number(row.station_lat),
      Number(row.station_lng)
    );
    const radius = Number.isFinite(Number(row.radius_miles)) ? Number(row.radius_miles) : DEFAULT_RADIUS_MILES;

    const sched = computeNextCheck({
      distanceMiles,
      radiusMiles: radius,
      speedMph: loc.speedMilesPerHour,
      nowMs: Date.now(),
    });

    if (!sched.withinRadius) {
      // Still approaching → store ETA and schedule the next wake-up.
      await db.rescheduleFuelStopAlert(row.id, {
        distanceMiles,
        etaMinutes: Math.round(sched.minutesToBoundary),
        etaBoundaryAt: new Date(sched.etaBoundaryAtMs).toISOString(),
        nextCheckAt: new Date(sched.nextCheckAtMs).toISOString(),
      });
      const inMin = Math.max(0, Math.round((sched.nextCheckAtMs - Date.now()) / 60_000));
      console.log(
        `[FUEL-ALERT] group ${row.group_id} ${distanceMiles.toFixed(1)}mi out; `
        + `ETA ~${Math.round(sched.minutesToBoundary)}min, next check in ~${inMin}min`
      );
      return { notified: false, reason: 'scheduled', distanceMiles };
    }

    // Within range → build and send the reminder, replying to the original.
    const tag = await buildDriverTag(row);
    const body = await buildReminderBody({ stationName: row.station_name, distanceMiles });
    const message = `⛽ ${tag} — ${escapeHtml(body)}`;

    try {
      await telegram.sendMessage(row.telegram_group_id, message, {
        reply_to_message_id: Number(row.source_message_id),
        parse_mode: 'HTML',
      });
    } catch (err) {
      // The original message may be gone; retry without the reply anchor.
      if (/reply|message to be replied|not found/i.test(String(err?.message || ''))) {
        await telegram.sendMessage(row.telegram_group_id, message, { parse_mode: 'HTML' });
      } else {
        throw err;
      }
    }

    await db.completeFuelStopAlert(row.id, { status: 'notified', distanceMiles });
    console.log(
      `[FUEL-ALERT] Reminder sent for group ${row.group_id} (${distanceMiles.toFixed(1)} mi to station)`
    );
    return { notified: true, distanceMiles };
  } catch (err) {
    console.error(`[FUEL-ALERT] processFuelAlert failed for row ${row.id}:`, err.message);
    await db.rescheduleFuelStopAlert(row.id, {
      nextCheckAt: minutesFromNowIso(RETRY_GAP_MIN),
      error: err.message,
    }).catch(() => {});
    return { notified: false, reason: 'error', error: err.message };
  }
}

/**
 * Build the manual "Send reminder" message (admin-triggered). Plain, instant,
 * no AI/GPS — just nudges the driver to their assigned fuel stop.
 */
async function buildManualReminderText(alert) {
  const tag = await buildDriverTag(alert);
  const station = normalizeText(alert?.station_name);
  const address = normalizeText(alert?.station_address);
  const where = station
    ? `your assigned fuel stop (${station})`
    : 'your assigned fuel stop';
  const body = `reminder: please fuel up at ${where}${address ? ` — ${address}` : ''} as instructed.`;
  return `⛽ ${tag} — ${escapeHtml(body)}`;
}

/**
 * Manually send a fuel reminder to a driver's group for their current active
 * fuel stop. Does NOT change the watch status, so the automatic 50-mile
 * reminder still fires later. Returns { sent, reason? }.
 */
async function sendManualFuelReminder(groupId) {
  const telegramClient = getFuelStopTelegram();
  if (!telegramClient) {
    throw new Error('Fuel reminder Telegram client is not configured.');
  }
  const alert = await db.getActiveFuelStopAlertForGroup(groupId);
  if (!alert) {
    return { sent: false, reason: 'no_active_alert' };
  }
  const message = await buildManualReminderText(alert);
  try {
    await telegramClient.sendMessage(alert.telegram_group_id, message, {
      reply_to_message_id: Number(alert.source_message_id),
      parse_mode: 'HTML',
    });
  } catch (err) {
    if (/reply|message to be replied|not found/i.test(String(err?.message || ''))) {
      await telegramClient.sendMessage(alert.telegram_group_id, message, { parse_mode: 'HTML' });
    } else {
      throw err;
    }
  }
  console.log(`[FUEL-ALERT] Manual reminder sent for group ${groupId}`);
  return { sent: true, station_name: alert.station_name || null };
}

module.exports = {
  buildReminderBody,
  processFuelAlert,
  buildManualReminderText,
  sendManualFuelReminder,
};
