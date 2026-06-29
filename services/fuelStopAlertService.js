/**
 * Fuel Monitor — gas-station proximity reminders.
 *
 * When the Fuel Monitoring team posts a gas-station location into a driver's
 * Telegram group, we record a "watching" row (database/db.js fuel_stop_alerts).
 * A lightweight poller then watches that driver's live truck GPS and, the
 * moment the truck comes within `radius_miles` of the station, replies to the
 * original message tagging the driver and reminding them to fuel there.
 *
 * Reuses existing building blocks:
 *   - resolveLiveLocationForGroupTitle()  — live truck GPS (Samsara/EVO/TT)
 *   - geocodePlace()                      — address → lat/lng (free providers)
 *   - haversineMiles()                    — straight-line distance (the radius)
 *   - callGeminiJson()/callGeminiText()   — detect + word the reminder
 *
 * Mirrors the watch/poll/claim shape of dispatchEtaUpdateService.js. Detection
 * is cheap-first: most messages are filtered out without any AI call.
 */
const db = require('../database/db');
const { resolveLiveLocationForGroupTitle } = require('./liveLocationResolver');
const { geocodePlace, haversineMiles } = require('./etaRoutingService');
const { callGeminiJson, callGeminiText } = require('./geminiClient');

const POLL_INTERVAL_MS = 150 * 1000; // 2.5 min — gentle on memory + APIs.
const ALERT_MAX_BATCH = 10;
const DEFAULT_RADIUS_MILES = 10;

// Keywords / patterns that mark a message as a possible fuel instruction.
// Kept broad on purpose; the AI step (or regex fallback) confirms.
const FUEL_KEYWORDS = /(\bfuel\b|fuel\s*up|fuel\s*station|gas\s*station|⛽|🛢|love'?s|pilot|flying\s*j|\bta\b|petro|speedway|sapp\s*bros|kwik|maverik|loves\s*travel)/i;
const MAPS_LINK = /(maps\.app\.goo\.gl|google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps)/i;
// Loose US street-address shape: "<number> <words>, <city>, ST <zip?>".
const ADDRESS_RE = /\d{1,6}\s+[A-Za-z0-9 .'\-/]+,\s*[A-Za-z .'\-]+,?\s*[A-Z]{2}\b(?:[, ]+\d{5}(?:-\d{4})?)?/;

let schedulerStopped = false;
let schedulerTimer = null;
let tickRunning = false;

function normalizeText(value) {
  return String(value || '').trim();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDriverDisplayName(row) {
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim();
  return name || 'Driver';
}

function milesLabel(distanceMiles) {
  if (!Number.isFinite(distanceMiles)) return 'a few';
  if (distanceMiles < 1) return 'less than 1';
  return String(Math.round(distanceMiles));
}

/**
 * Extract a station from a Telegram message, if it looks like a fuel stop.
 * Returns { latitude, longitude, stationName, stationAddress } or null.
 * No DB writes; safe to call on every group message.
 */
async function detectStationFromMessage(message) {
  if (!message) return null;

  // 1. Telegram location pin / venue → coordinates are exact, no geocoding.
  const venue = message.venue;
  const pin = message.location || venue?.location;
  if (pin && Number.isFinite(pin.latitude) && Number.isFinite(pin.longitude)) {
    return {
      latitude: pin.latitude,
      longitude: pin.longitude,
      stationName: normalizeText(venue?.title) || null,
      stationAddress: normalizeText(venue?.address) || null,
    };
  }

  // 2. Text/caption: cheap pre-filter before any AI cost.
  const text = normalizeText(message.text || message.caption || '');
  if (!text) return null;
  const looksFuelish = FUEL_KEYWORDS.test(text) || MAPS_LINK.test(text) || ADDRESS_RE.test(text);
  if (!looksFuelish) return null;

  // 3. AI confirm + extract the station name and address (best effort).
  let stationName = null;
  let address = null;
  try {
    const { parsed } = await callGeminiJson({
      systemText:
        'You read Telegram messages posted in a truck driver\'s group. Decide if the message '
        + 'instructs the driver to STOP and FUEL at a specific gas/fuel station, and if so extract '
        + 'the station name and its full street address.',
      userText:
        `Message:\n"""${text.slice(0, 1200)}"""\n\n`
        + 'Respond ONLY with JSON: '
        + '{"is_fuel_instruction": boolean, "station_name": string, "address": string}. '
        + 'If it is not a fuel instruction set is_fuel_instruction=false and use empty strings.',
      maxOutputTokens: 200,
      validateParsed: (p) => typeof p?.is_fuel_instruction === 'boolean',
    });
    if (parsed && parsed.is_fuel_instruction === false) {
      // AI is confident this is not a fuel instruction → drop it.
      return null;
    }
    stationName = normalizeText(parsed?.station_name) || null;
    address = normalizeText(parsed?.address) || null;
  } catch (err) {
    // AI unavailable / quota — fall through to regex extraction.
    console.warn('[FUEL-ALERT] AI extraction failed, using regex fallback:', err.message);
  }

  // 4. Regex address fallback when AI gave nothing usable.
  if (!address) {
    const match = text.match(ADDRESS_RE);
    address = match ? normalizeText(match[0]) : '';
  }
  if (!address) return null;

  // 5. Geocode the address to coordinates (free Nominatim/Photon, optional Google).
  const geo = await geocodePlace(address).catch(() => null);
  if (!geo || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) {
    console.warn(`[FUEL-ALERT] Could not geocode fuel address: "${address.slice(0, 120)}"`);
    return null;
  }
  return {
    latitude: geo.latitude,
    longitude: geo.longitude,
    stationName,
    stationAddress: address,
  };
}

/**
 * Called (detached) from the bot's group-message handler for active driver
 * groups. Detects a fuel-stop message and starts watching the truck. Never
 * throws.
 */
async function handleFuelStopMessage(telegram, group, message) {
  try {
    if (!group || group.group_type !== 'driver' || !group.active) return;
    const messageId = message?.message_id;
    if (!messageId) return;

    const station = await detectStationFromMessage(message);
    if (!station) return;

    const alert = await db.createFuelStopAlert({
      groupId: group.id,
      telegramGroupId: group.telegram_group_id,
      sourceMessageId: messageId,
      stationName: station.stationName,
      stationAddress: station.stationAddress,
      stationLat: station.latitude,
      stationLng: station.longitude,
      radiusMiles: DEFAULT_RADIUS_MILES,
    });
    if (alert) {
      console.log(
        `[FUEL-ALERT] Watching group ${group.id} for fuel stop `
        + `${station.stationName ? `"${station.stationName}" ` : ''}`
        + `(${station.latitude.toFixed(4)}, ${station.longitude.toFixed(4)})`
      );
    }
  } catch (err) {
    console.error('[FUEL-ALERT] handleFuelStopMessage failed:', err.message);
  }
}

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
      // hiccup). Keep watching; the 24h expiry is the backstop.
      await db.completeFuelStopAlert(row.id, { status: 'watching', error: err.message });
      return { notified: false, reason: 'no_location' };
    }

    const loc = resolved?.location || {};
    if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
      await db.completeFuelStopAlert(row.id, { status: 'watching', error: 'No GPS coordinates' });
      return { notified: false, reason: 'no_coords' };
    }

    const distanceMiles = haversineMiles(
      loc.latitude,
      loc.longitude,
      Number(row.station_lat),
      Number(row.station_lng)
    );
    const radius = Number.isFinite(Number(row.radius_miles)) ? Number(row.radius_miles) : DEFAULT_RADIUS_MILES;

    if (!(distanceMiles <= radius)) {
      await db.completeFuelStopAlert(row.id, { status: 'watching', distanceMiles });
      return { notified: false, reason: 'far', distanceMiles };
    }

    // Within range → build and send the reminder, replying to the original.
    const username = normalizeText(row.telegram_username);
    const tag = username ? `@${username}` : escapeHtml(buildDriverDisplayName(row));
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
    await db.completeFuelStopAlert(row.id, { status: 'watching', error: err.message }).catch(() => {});
    return { notified: false, reason: 'error', error: err.message };
  }
}

let telegramClient = null;

function configureFuelStopTelegram(telegram) {
  telegramClient = telegram || null;
}

async function tickFuelStopAlerts() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await db.expireOldFuelStopAlerts().catch(() => {});
    if (!telegramClient) return;

    const due = await db.claimDueFuelStopAlerts(ALERT_MAX_BATCH);
    if (!due.length) return;

    console.log(`[FUEL-ALERT] Processing ${due.length} watched fuel stop(s)`);
    for (const row of due) {
      if (schedulerStopped) break;
      await processFuelAlert(telegramClient, row);
    }
  } catch (err) {
    console.error('[FUEL-ALERT] Tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function scheduleNextTick() {
  if (schedulerStopped) return;
  schedulerTimer = setTimeout(async () => {
    await tickFuelStopAlerts();
    scheduleNextTick();
  }, POLL_INTERVAL_MS);
  schedulerTimer.unref?.();
}

function startFuelStopAlertService(telegram) {
  if (telegram) configureFuelStopTelegram(telegram);
  schedulerStopped = false;
  console.log(`[FUEL-ALERT] Service started; polling every ${POLL_INTERVAL_MS / 1000}s`);
  (async () => {
    await tickFuelStopAlerts();
    scheduleNextTick();
  })();
}

function stopFuelStopAlertService() {
  schedulerStopped = true;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  console.log('[FUEL-ALERT] Service stopped.');
}

module.exports = {
  configureFuelStopTelegram,
  detectStationFromMessage,
  handleFuelStopMessage,
  buildReminderBody,
  processFuelAlert,
  tickFuelStopAlerts,
  startFuelStopAlertService,
  stopFuelStopAlertService,
};
