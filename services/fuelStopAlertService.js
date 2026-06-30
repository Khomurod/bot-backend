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

const POLL_INTERVAL_MS = 150 * 1000; // due-scan cadence (cheap; most ticks no-op).
const ALERT_MAX_BATCH = 10;
const DEFAULT_RADIUS_MILES = 10;

// ETA-based scheduling knobs. We estimate when the truck will reach the radius
// from straight-line distance ÷ speed (no extra routing API), then wake up
// ~PRE_ARRIVAL_LEAD_MIN before that, polling tightly only near arrival.
const AVG_SPEED_MPH = 50;          // assumed when the truck is stopped / no speed
const ROAD_FACTOR = 1.2;           // roads are longer than straight line
const PRE_ARRIVAL_LEAD_MIN = 20;   // re-verify ~20 min before predicted arrival
const NEAR_GAP_MIN = 3;            // tight polling once close to the boundary
const MIN_GAP_MIN = 2;             // never schedule sooner than this
const MAX_GAP_MIN = 360;           // never sleep longer than 6h between checks
const RETRY_GAP_MIN = 5;           // truck offline / no GPS → retry soon
const SPEED_MIN_MPH = 5;
const SPEED_MAX_MPH = 75;

// The ONLY trigger: the Fuel Monitoring team always opens their instruction
// with the "FUEL MONITORING DEPARTMENT" banner (surrounded by emojis). We gate
// strictly on this header so ordinary chatter and load-location updates (which
// also contain addresses/maps links) are never mistaken for a fuel stop.
const FUEL_HEADER_RE = /fuel\s*monitoring\s*department/i;
// Loose US street-address shape: "<number> <words>, <city>, ST <zip?>" — used
// only to pull the address OUT of a message already confirmed by the header.
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

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function minutesFromNowIso(minutes) {
  return new Date(Date.now() + Math.max(0, minutes) * 60_000).toISOString();
}

/**
 * Decide when to next evaluate a watch row, or that it is already within range.
 * Pure (no I/O): pass nowMs. Returns either { withinRadius: true } or
 * { minutesToBoundary, etaBoundaryAtMs, nextCheckAtMs }.
 */
function computeNextCheck({ distanceMiles, radiusMiles = DEFAULT_RADIUS_MILES, speedMph, nowMs }) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const radius = Number.isFinite(radiusMiles) ? radiusMiles : DEFAULT_RADIUS_MILES;
  if (!(Number(distanceMiles) > radius)) {
    return { withinRadius: true };
  }
  const milesBeyond = Number(distanceMiles) - radius;
  const speed = (Number.isFinite(speedMph) && speedMph > SPEED_MIN_MPH)
    ? clamp(speedMph, SPEED_MIN_MPH, SPEED_MAX_MPH)
    : AVG_SPEED_MPH;
  const minutesToBoundary = (milesBeyond * ROAD_FACTOR / speed) * 60;
  const etaBoundaryAtMs = now + minutesToBoundary * 60_000;

  // Far away → wake ~20 min before predicted arrival. Close → poll tightly.
  let gapMin = minutesToBoundary > (PRE_ARRIVAL_LEAD_MIN + NEAR_GAP_MIN + 2)
    ? minutesToBoundary - PRE_ARRIVAL_LEAD_MIN
    : NEAR_GAP_MIN;
  gapMin = clamp(gapMin, MIN_GAP_MIN, MAX_GAP_MIN);

  return {
    withinRadius: false,
    minutesToBoundary,
    etaBoundaryAtMs,
    nextCheckAtMs: now + gapMin * 60_000,
  };
}

/** The raw text of a message (text or caption), trimmed. */
function messageText(message) {
  return normalizeText(message?.text || message?.caption || '');
}

/**
 * True only when the message STARTS with the Fuel Monitoring Department banner
 * (its first non-empty line). Case-insensitive and tolerant of the surrounding
 * emojis/whitespace. This is the sole trigger for the whole feature.
 */
function messageHasFuelHeader(text) {
  const firstLine = (String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)) || '';
  return FUEL_HEADER_RE.test(firstLine);
}

/**
 * Pull a station name + street address out of an already-confirmed fuel
 * message using regex only (no AI, no network). Returns { stationName, address }
 * with empty strings when nothing is found.
 */
function extractStationFromText(text) {
  const raw = String(text || '');
  const addressMatch = raw.match(ADDRESS_RE);
  const address = addressMatch ? normalizeText(addressMatch[0]) : '';

  // Station name usually follows a "⛽: <name>" / ": <name>" line under the
  // banner (e.g. "⛽ : Loves Travel Stop"). Best-effort only.
  let stationName = '';
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^[^A-Za-z0-9]*:?\s*([A-Za-z][A-Za-z0-9 '&./-]{2,60})$/);
    if (m && !FUEL_HEADER_RE.test(lines[i]) && !/please|fuel up|good day|station/i.test(lines[i])) {
      stationName = normalizeText(m[1]);
      break;
    }
  }
  return { stationName, address };
}

/** True when the driver profile is an active company driver (Fuel Monitor scope). */
function isCompanyDriverProfile(profile) {
  return Boolean(profile)
    && profile.driver_type === 'company_driver'
    && profile.status !== 'inactive';
}

/**
 * Detect a fuel-stop instruction in a Telegram message.
 * Returns { latitude, longitude, stationName, stationAddress } or null.
 * Gated on the FUEL MONITORING DEPARTMENT header so load-location updates,
 * plain chatter, and stray location pins are ignored. No DB writes.
 */
async function detectStationFromMessage(message) {
  if (!message) return null;

  // SOLE GATE: must start with the Fuel Monitoring Department banner.
  const text = messageText(message);
  if (!messageHasFuelHeader(text)) return null;

  // AI confirm + extract the station name and address (best effort).
  let stationName = null;
  let address = null;
  try {
    const { parsed } = await callGeminiJson({
      systemText:
        'You read fuel-stop instructions posted by a Fuel Monitoring Department in a truck '
        + 'driver\'s group. Extract the fuel station name and its full street address.',
      userText:
        `Message:\n"""${text.slice(0, 1200)}"""\n\n`
        + 'Respond ONLY with JSON: '
        + '{"station_name": string, "address": string}. Use empty strings if unknown.',
      maxOutputTokens: 200,
      validateParsed: (p) => p && typeof p === 'object',
    });
    stationName = normalizeText(parsed?.station_name) || null;
    address = normalizeText(parsed?.address) || null;
  } catch (err) {
    // AI unavailable / quota — fall through to regex extraction.
    console.warn('[FUEL-ALERT] AI extraction failed, using regex fallback:', err.message);
  }

  // Regex fallback when AI gave nothing usable.
  if (!address || !stationName) {
    const extracted = extractStationFromText(text);
    if (!address) address = extracted.address;
    if (!stationName) stationName = extracted.stationName || null;
  }
  if (!address) {
    console.warn('[FUEL-ALERT] Fuel header found but no address could be extracted.');
    return null;
  }

  // Geocode the address to coordinates (free Nominatim/Photon, optional Google).
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
 * React to a Telegram message with an emoji (default 👍) to confirm the bot
 * recognized it. Never throws — a failed reaction must not block the alert.
 */
async function reactToFuelMessage(telegram, chatId, messageId, emoji = '👍') {
  if (!telegram || !chatId || !messageId) return;
  try {
    const reaction = [{ type: 'emoji', emoji }];
    if (typeof telegram.setMessageReaction === 'function') {
      await telegram.setMessageReaction(chatId, messageId, reaction);
    } else {
      await telegram.callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction,
      });
    }
  } catch (err) {
    console.warn('[FUEL-ALERT] Could not set reaction:', err.message);
  }
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

    // Cheap string gate first — bail before any DB/AI/geocode work unless this
    // message is an actual Fuel Monitoring Department instruction.
    const text = messageText(message);
    if (!messageHasFuelHeader(text)) return;

    // Only company drivers are in the Fuel Monitor scope (matches the admin
    // page's source of truth). Owner-operators / non-company groups are ignored.
    const profile = await db.getDriverProfileByGroupId(group.id).catch(() => null);
    if (!isCompanyDriverProfile(profile)) return;

    // Record the message in the inbox so Refresh can retry if detection fails.
    const inboxRow = await db.recordFuelInboxMessage({
      groupId: group.id,
      telegramGroupId: group.telegram_group_id,
      messageId,
      messageText: text,
    }).catch(() => null);

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
      // Mark the inbox row as picked up and react with 👍 to confirm pickup.
      if (inboxRow) {
        await db.markFuelInboxPickedUp(inboxRow.id, alert.id).catch(() => {});
      }
      await reactToFuelMessage(telegram, group.telegram_group_id, messageId);

      console.log(
        `[FUEL-ALERT] Watching group ${group.id} for fuel stop `
        + `${station.stationName ? `"${station.stationName}" ` : ''}`
        + `(${station.latitude.toFixed(4)}, ${station.longitude.toFixed(4)})`
      );
      // Immediately compute the first ETA (and send right away if the truck is
      // already within range). The claim re-fetches the join columns.
      const claimed = await db.claimFuelStopAlertById(alert.id).catch(() => null);
      if (claimed) await processFuelAlert(telegram, claimed);
    }
  } catch (err) {
    console.error('[FUEL-ALERT] handleFuelStopMessage failed:', err.message);
  }
}

/**
 * Re-scan pending inbox rows (fuel messages the bot saw but whose
 * detection/geocoding may have failed transiently). For each pending row,
 * re-run the full detection pipeline; on success create an alert, react with 👍,
 * and mark the inbox row picked_up. Returns { scanned, pickedUp }.
 */
async function refreshFuelStopsFromInbox(telegram) {
  if (!telegram) return { scanned: 0, pickedUp: 0 };
  const rows = await db.listPendingFuelInbox(24, 50).catch(() => []);
  let pickedUp = 0;
  for (const row of rows) {
    try {
      const fakeMsg = { message_id: Number(row.message_id), text: row.message_text };
      const station = await detectStationFromMessage(fakeMsg);
      if (!station) continue;

      const alert = await db.createFuelStopAlert({
        groupId: row.group_id,
        telegramGroupId: row.telegram_group_id,
        sourceMessageId: Number(row.message_id),
        stationName: station.stationName,
        stationAddress: station.stationAddress,
        stationLat: station.latitude,
        stationLng: station.longitude,
        radiusMiles: DEFAULT_RADIUS_MILES,
      });
      if (alert) {
        await db.markFuelInboxPickedUp(row.id, alert.id).catch(() => {});
        await reactToFuelMessage(telegram, Number(row.telegram_group_id), Number(row.message_id));
        const claimed = await db.claimFuelStopAlertById(alert.id).catch(() => null);
        if (claimed) await processFuelAlert(telegram, claimed);
        pickedUp += 1;
        console.log(`[FUEL-ALERT] Refresh: picked up inbox row ${row.id} for group ${row.group_id}`);
      }
    } catch (err) {
      console.warn(`[FUEL-ALERT] Refresh: inbox row ${row.id} failed:`, err.message);
    }
  }
  return { scanned: rows.length, pickedUp };
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
function buildManualReminderText(alert) {
  const username = normalizeText(alert?.telegram_username);
  const tag = username ? `@${username}` : escapeHtml(buildDriverDisplayName(alert));
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
 * fuel stop. Does NOT change the watch status, so the automatic 10-mile
 * reminder still fires later. Returns { sent, reason? }.
 */
async function sendManualFuelReminder(groupId) {
  if (!telegramClient) {
    throw new Error('Fuel reminder Telegram client is not configured.');
  }
  const alert = await db.getActiveFuelStopAlertForGroup(groupId);
  if (!alert) {
    return { sent: false, reason: 'no_active_alert' };
  }
  const message = buildManualReminderText(alert);
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

let telegramClient = null;

function configureFuelStopTelegram(telegram) {
  telegramClient = telegram || null;
}

async function tickFuelStopAlerts() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await db.expireOldFuelStopAlerts().catch(() => {});
    await db.deleteOldFuelInbox(3).catch(() => {});
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
  messageHasFuelHeader,
  messageText,
  extractStationFromText,
  isCompanyDriverProfile,
  computeNextCheck,
  detectStationFromMessage,
  reactToFuelMessage,
  handleFuelStopMessage,
  refreshFuelStopsFromInbox,
  buildReminderBody,
  buildManualReminderText,
  sendManualFuelReminder,
  processFuelAlert,
  tickFuelStopAlerts,
  startFuelStopAlertService,
  stopFuelStopAlertService,
};
