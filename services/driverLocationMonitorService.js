/**
 * Driver Location Monitoring service.
 *
 * For each driver group toggled ON in the admin panel, this service:
 *   1. resolves the driver's current load — primarily from Datatruck (matched
 *      by driver name), with the AI-parsed load context as a fallback;
 *   2. decides whether the truck is heading to the shipper (pickup) or the
 *      receiver (delivery) — using AI, with a time-based heuristic fallback;
 *   3. tracks the live ETA to that stop (reusing the routing/geocoding stack);
 *   4. polls adaptively — loosely when far, tightly as the truck closes in;
 *   5. when the truck enters the check-in radius, sends a "report your status
 *      at the shipper/receiver" prompt with Checked In / Checked Out buttons to
 *      the driver group — exactly once per (load, stop_type).
 *
 * The driver's answer (recorded by bot/locationCheckinHandlers.js) builds the
 * shipper/receiver on-time performance history. A durable one-prompt-per-stop
 * guard (hasCheckinForStop + a UNIQUE index) prevents the duplicate spam that
 * re-asking on every pass used to cause.
 *
 * Read-only against Datatruck and the GPS/ELD providers. Mirrors the
 * claim/poll/reschedule shape of dispatchEtaUpdateService + fuelStopAlertService.
 */
const { DateTime } = require('luxon');
const config = require('../config/config');
const monitorsDb = require('../database/driverLocationMonitors');
const datatruck = require('./datatruckApiService');
const datatruckLoadService = require('./datatruckLoadService');
const { resolveLiveLocationForGroupTitle } = require('./liveLocationResolver');
const { calculateEtaToDestination, geocodePlace, haversineMiles } = require('./etaRoutingService');
const { readLoadContextWithFallbacks } = require('./dispatchPinnedContextService');
const { extractDriverNameFromGroupTitle } = require('./driverGroupTitle');
const db = require('../database/db');
const { buildMention, createMentionResolver } = require('./telegramMention');

// Resolve a username-less driver to a tg://user?id inline mention by looking
// their captured id up by name, so the check-in ping still notifies them.
const mentionResolver = createMentionResolver(db);

let geminiClient = null;
try {
  geminiClient = require('./geminiClient');
} catch (_) {
  geminiClient = null;
}

const POLL_INTERVAL_MS = 90 * 1000;   // due-scan cadence; most ticks are no-ops.
const MAX_BATCH = 10;
const DEFAULT_RADIUS_MILES = 8;        // fires inside the operator's 10–5 mi band
const DEFAULT_INTERVAL_MIN = 30;       // re-poll cap when far from the stop
const RETRY_GAP_MIN = 5;               // truck offline / no load → retry soon
const NO_ANSWER_REPROMPT_MIN = 20;     // re-ask if a prompt went unanswered
const MIN_GAP_MIN = 2;
const APPOINTMENT_GRACE_MIN = 15;      // counted on-time if within this of appt

let schedulerStopped = false;
let schedulerTimer = null;
let tickRunning = false;
let telegramClient = null;

function configureDriverLocationTelegram(telegram) {
  telegramClient = telegram || null;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function minutesFromNowIso(minutes) {
  return DateTime.utc().plus({ minutes: Math.max(0, Number(minutes) || 0) }).toISO();
}

function buildDriverDisplayName(row) {
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim();
  return name || extractDriverNameFromGroupTitle(row?.group_name) || 'Driver';
}

function parseIsoMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? ms : null;
}

// ─── Load resolution ───

/**
 * Normalize a raw Datatruck order into structured stop fields. Delegates to the
 * shared datatruckLoadService field-pluck (no AI, no OCR — structured JSON in,
 * structured stops out).
 */
function extractStopsFromOrder(order) {
  return datatruckLoadService.extractStopsFromOrder(order);
}

/**
 * Resolve the driver's current load into a structured shape:
 *   { source, orderId, pickupAddress, deliveryAddress, pickupTime, deliveryTime }
 * Datatruck order first; AI-parsed load context (pinned/recent/chat) as fallback.
 */
async function resolveLoad({ driverName, telegram, telegramGroupId, groupId }) {
  // 1) Datatruck active order (primary source of truth).
  if (datatruck.isConfigured() && driverName) {
    try {
      const load = await datatruckLoadService.resolveActiveLoadForDriver(driverName);
      if (load && (load.pickupAddress || load.deliveryAddress)) {
        return {
          source: 'datatruck',
          orderId: load.orderId,
          pickupAddress: load.pickupAddress,
          deliveryAddress: load.deliveryAddress,
          pickupTime: load.pickupTime,
          deliveryTime: load.deliveryTime,
          shipperName: load.shipperName,
          receiverName: load.receiverName,
        };
      }
    } catch (err) {
      console.warn('[LOCATION-MONITOR] Datatruck load lookup failed:', err.message);
    }
  }

  // 2) AI-parsed load context fallback (rate-con cache / pinned / chat history).
  try {
    const ctx = await readLoadContextWithFallbacks({
      telegram,
      chatId: telegramGroupId,
      groupId,
    });
    return {
      source: `fallback:${ctx.source || 'load-context'}`,
      orderId: null,
      pickupAddress: normalizeText(ctx.pickupSummary),
      deliveryAddress: normalizeText(ctx.deliverySummary) || normalizeText(ctx.destinationQuery),
      pickupTime: ctx.pickupWindowEnd || ctx.pickup_window_end || null,
      deliveryTime: ctx.deliveryWindowEnd || ctx.delivery_window_end || null,
      shipperName: '',
      receiverName: '',
    };
  } catch (err) {
    if (err?.code === 'LOAD_CONTEXT_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

// ─── Direction (shipper vs receiver) ───

/**
 * Heuristic baseline: head to the pickup while its appointment is still ahead
 * (with a small grace), otherwise the load has been picked up and we're heading
 * to delivery.
 */
function heuristicPhase({ pickupTime, deliveryTime, nowMs }) {
  const pu = parseIsoMs(pickupTime);
  const del = parseIsoMs(deliveryTime);
  if (pu != null && pu >= nowMs - APPOINTMENT_GRACE_MIN * 60_000) return 'heading_pickup';
  if (del != null) return 'heading_delivery';
  if (pu != null) return 'heading_pickup';
  return 'heading_delivery';
}

/**
 * Decide whether the truck is heading to the shipper or the receiver. Uses AI
 * given the current location + both stops, falling back to the time heuristic.
 */
async function decideTargetPhase({ load, truckAddress, nowMs }) {
  const baseline = heuristicPhase({
    pickupTime: load.pickupTime,
    deliveryTime: load.deliveryTime,
    nowMs,
  });

  // Only one stop known → no decision to make.
  if (!load.pickupAddress) return 'heading_delivery';
  if (!load.deliveryAddress) return 'heading_pickup';

  if (!geminiClient || !geminiClient.GEMINI_API_KEY) {
    return baseline;
  }

  try {
    const nowLabel = DateTime.fromMillis(nowMs).setZone('America/Chicago').toFormat('yyyy-MM-dd HH:mm');
    const prompt = [
      'A truck is on an active load. Decide whether it is currently heading to the PICKUP (shipper) or the DELIVERY (receiver).',
      `Current time (CT): ${nowLabel}`,
      `Truck current location: ${truckAddress || 'unknown'}`,
      `Pickup (shipper): ${load.pickupAddress || 'unknown'} | appointment: ${load.pickupTime || 'unknown'}`,
      `Delivery (receiver): ${load.deliveryAddress || 'unknown'} | appointment: ${load.deliveryTime || 'unknown'}`,
      'Reasoning: if the pickup appointment is still in the future, the truck is most likely heading to pickup; once picked up it heads to delivery. Use the location proximity too.',
      'Return JSON only: {"target":"pickup"|"delivery"}',
    ].join('\n');

    const { parsed } = await geminiClient.callGeminiJson({
      userText: prompt,
      maxOutputTokens: 60,
      maxRetryWaitMs: 5000,
    });
    const target = normalizeText(parsed?.target).toLowerCase();
    if (target === 'pickup') return 'heading_pickup';
    if (target === 'delivery') return 'heading_delivery';
  } catch (err) {
    console.warn('[LOCATION-MONITOR] AI phase decision failed:', err.message);
  }
  return baseline;
}

function phaseToStopType(phase) {
  return phase === 'heading_pickup' ? 'shipper' : 'receiver';
}

// ─── Adaptive scheduling ───

/**
 * Pick the next wake-up delay (minutes): tight near the stop, loose when far.
 * delay ≈ etaMinutes / 3, clamped to [MIN_GAP_MIN, intervalCap].
 */
function nextCheckMinutes({ etaMinutes, intervalCap }) {
  const cap = Number.isInteger(intervalCap) && intervalCap > 0 ? intervalCap : DEFAULT_INTERVAL_MIN;
  if (!Number.isFinite(etaMinutes) || etaMinutes <= 0) return Math.min(cap, RETRY_GAP_MIN);
  const proposed = Math.round(etaMinutes / 3);
  return Math.max(MIN_GAP_MIN, Math.min(cap, proposed));
}

// ─── Check-in message ───

function buildCheckinMessageFallback({ driverTag, stopType, locationLabel, milesText, language }) {
  const where = stopType === 'shipper' ? 'shipper (pickup)' : 'receiver (delivery)';
  const whereRu = stopType === 'shipper' ? 'грузоотправителя (погрузка)' : 'грузополучателя (выгрузка)';
  const whereUz = stopType === 'shipper' ? 'yuk yuklovchi (pickup)' : 'yuk qabul qiluvchi (delivery)';
  const place = locationLabel ? ` (${escapeHtml(locationLabel)})` : '';
  if (language === 'ru') {
    return `📍 ${driverTag} — вы примерно в ${milesText} миль(ях) от ${whereRu}${place}. Сообщите статус кнопкой ниже: «Отметился» (Checked In) или «Выехал» (Checked Out).`;
  }
  if (language === 'uz') {
    return `📍 ${driverTag} — siz ${whereUz}${place}dan taxminan ${milesText} mil uzoqdasiz. Quyidagi tugma orqali holatingizni bildiring: «Checked In» yoki «Checked Out».`;
  }
  return `📍 ${driverTag} — you're about ${milesText} miles from the ${where}${place}. Report your status at the ${stopType} using the buttons below: Checked In or Checked Out.`;
}

/** Word the check-in prompt with AI when available; fall back to templates. */
async function buildCheckinMessage({ driverTag, stopType, locationLabel, distanceMiles, language }) {
  const milesText = Number.isFinite(distanceMiles)
    ? (distanceMiles < 1 ? 'less than 1' : String(Math.round(distanceMiles)))
    : 'a few';
  const fallback = buildCheckinMessageFallback({ driverTag, stopType, locationLabel, milesText, language });

  if (!geminiClient || !geminiClient.GEMINI_API_KEY) return fallback;

  const langLabel = language === 'ru' ? 'Russian' : language === 'uz' ? 'Uzbek' : 'English';
  try {
    const prompt = [
      `Write a short, friendly Telegram message in ${langLabel} to a truck driver.`,
      `The driver is about ${milesText} miles from the ${stopType === 'shipper' ? 'shipper (pickup location)' : 'receiver (delivery location)'}${locationLabel ? ` at ${locationLabel}` : ''}.`,
      `Ask them to report their status at the ${stopType} using the two buttons below the message: "Checked In" or "Checked Out". Keep it to one sentence. Start with "${driverTag}" exactly (it is a mention). Do not add buttons or quotes.`,
    ].join('\n');
    const { text } = await geminiClient.callGeminiText({
      userText: prompt,
      maxOutputTokens: 120,
      maxRetryWaitMs: 5000,
    });
    const out = normalizeText(text);
    if (out && out.includes(driverTag)) return `📍 ${out.replace(/^📍\s*/, '')}`;
    if (out) return `📍 ${driverTag} — ${out}`;
  } catch (err) {
    console.warn('[LOCATION-MONITOR] AI message generation failed:', err.message);
  }
  return fallback;
}

function buildKeyboard(checkinId) {
  return {
    inline_keyboard: [[
      { text: '✅ Checked In', callback_data: `loccheck:in:${checkinId}` },
      { text: '🚪 Checked Out', callback_data: `loccheck:out:${checkinId}` },
    ]],
  };
}

// ─── Core job ───

async function resolveLiveTitle(telegram, row) {
  let title = normalizeText(row.group_name);
  try {
    const chat = await telegram.getChat(row.telegram_group_id);
    const chatTitle = normalizeText(chat?.title);
    if (chatTitle) title = chatTitle;
  } catch (err) {
    console.warn(`[LOCATION-MONITOR] Could not refresh chat title for ${row.telegram_group_id}: ${err.message}`);
  }
  return title;
}

async function processMonitorJob(job) {
  const intervalCap = Number(job.interval_minutes) > 0 ? Number(job.interval_minutes) : DEFAULT_INTERVAL_MIN;
  const radius = Number.isFinite(Number(job.checkin_radius_miles)) ? Number(job.checkin_radius_miles) : DEFAULT_RADIUS_MILES;
  const nowMs = Date.now();

  try {
    if (!telegramClient) {
      throw new Error('Driver location monitor Telegram client is not configured.');
    }

    const title = await resolveLiveTitle(telegramClient, job);
    const driverName = buildDriverDisplayName(job) === 'Driver'
      ? extractDriverNameFromGroupTitle(title)
      : [job.first_name, job.last_name].filter(Boolean).join(' ').trim() || extractDriverNameFromGroupTitle(title);

    // 1) Live truck location.
    let resolved = null;
    try {
      resolved = await resolveLiveLocationForGroupTitle(title);
    } catch (err) {
      await monitorsDb.releaseMonitor(job.id, {
        nextRunAt: minutesFromNowIso(RETRY_GAP_MIN),
        lastStatus: 'no_location',
        lastError: err.message,
        activeCheckinId: job.active_checkin_id || null,
      });
      return { ok: false, reason: 'no_location' };
    }
    const loc = resolved?.location || {};
    if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
      await monitorsDb.releaseMonitor(job.id, {
        nextRunAt: minutesFromNowIso(RETRY_GAP_MIN),
        lastStatus: 'no_coords',
        lastError: 'No GPS coordinates from providers.',
        activeCheckinId: job.active_checkin_id || null,
      });
      return { ok: false, reason: 'no_coords' };
    }

    // 2) Current load (Datatruck → AI fallback).
    const load = await resolveLoad({
      driverName,
      telegram: telegramClient,
      telegramGroupId: job.telegram_group_id,
      groupId: job.group_id,
    });
    if (!load || (!load.pickupAddress && !load.deliveryAddress)) {
      await monitorsDb.releaseMonitor(job.id, {
        nextRunAt: minutesFromNowIso(intervalCap),
        lastStatus: 'no_load',
        lastError: 'No active load found for this driver.',
        activeCheckinId: null,
      });
      return { ok: false, reason: 'no_load' };
    }

    // 3) Direction: shipper (pickup) vs receiver (delivery).
    const phase = job.load_phase && job.active_checkin_id
      ? job.load_phase
      : await decideTargetPhase({ load, truckAddress: loc.address, nowMs });
    const stopType = phaseToStopType(phase);
    const targetAddress = phase === 'heading_pickup' ? load.pickupAddress : load.deliveryAddress;
    const appointmentIso = phase === 'heading_pickup' ? load.pickupTime : load.deliveryTime;

    if (!targetAddress) {
      await monitorsDb.releaseMonitor(job.id, {
        nextRunAt: minutesFromNowIso(intervalCap),
        lastStatus: 'no_target',
        lastError: `No ${stopType} address in load.`,
        currentOrderId: load.orderId,
        loadPhase: phase,
        activeCheckinId: null,
      });
      return { ok: false, reason: 'no_target' };
    }

    // 4) ETA + distance to the target stop.
    let eta = null;
    try {
      eta = await calculateEtaToDestination({
        currentLatitude: loc.latitude,
        currentLongitude: loc.longitude,
        destinationQuery: targetAddress,
      });
    } catch (err) {
      console.warn('[LOCATION-MONITOR] ETA calc failed:', err.message);
    }

    // Distance: prefer routed miles; fall back to straight-line if we can geocode.
    let distanceMiles = eta && Number.isFinite(eta.remainingMiles) ? eta.remainingMiles : null;
    let targetCoords = eta?.destination || null;
    if (distanceMiles == null) {
      try {
        const geo = await geocodePlace(targetAddress);
        if (geo) {
          targetCoords = geo;
          distanceMiles = haversineMiles(loc.latitude, loc.longitude, geo.latitude, geo.longitude);
        }
      } catch (_) { /* leave distance null */ }
    }

    const etaMinutes = eta && Number.isFinite(eta.etaMinutes) ? eta.etaMinutes : null;
    const etaAtIso = etaMinutes != null ? minutesFromNowIso(etaMinutes) : null;

    const baseState = {
      currentOrderId: load.orderId,
      loadPhase: phase,
      targetStopType: stopType,
      targetAddress,
      targetLat: targetCoords?.latitude,
      targetLng: targetCoords?.longitude,
      targetAppointmentAt: appointmentIso || null,
      lastEtaMinutes: etaMinutes != null ? Math.round(etaMinutes) : null,
      lastEtaAt: etaAtIso,
      lastDistanceMiles: distanceMiles,
      cachedContextJson: {
        loadSource: load.source,
        truckAddress: loc.address || null,
        locationSource: resolved.source || null,
        updatedAt: new Date().toISOString(),
      },
    };

    // If a prompt is still awaiting an answer, don't send another — just
    // refresh state and re-check after a cooldown. If the open prompt was
    // answered (handler already advanced us) or expired, clear active_checkin_id
    // and fall through. We do NOT re-prompt the same stop: the
    // hasCheckinForStop guard below blocks a second message regardless of
    // whether the driver answered, reported "checked out", or never answered.
    if (job.active_checkin_id) {
      const openCheckin = await monitorsDb.getCheckinById(job.active_checkin_id);
      if (openCheckin && openCheckin.status === 'awaiting_response') {
        await monitorsDb.releaseMonitor(job.id, {
          ...baseState,
          nextRunAt: minutesFromNowIso(NO_ANSWER_REPROMPT_MIN),
          lastStatus: 'awaiting_checkin',
          lastError: null,
          activeCheckinId: job.active_checkin_id,
        });
        return { ok: true, reason: 'awaiting_checkin' };
      }
      job.active_checkin_id = null;
    }

    // One-prompt-per-stop guard: if this order+stop (or, for null-order fallback
    // loads, this group+address+stop) was ever prompted, never prompt it again.
    // This is the fix for the duplicate/spam reports — a stop is asked at most
    // once whether or not the driver answered.
    const alreadyPrompted = await monitorsDb.hasCheckinForStop({
      groupId: job.group_id,
      orderId: load.orderId,
      stopType,
      targetAddress,
    });
    if (alreadyPrompted) {
      await monitorsDb.releaseMonitor(job.id, {
        ...baseState,
        nextRunAt: minutesFromNowIso(intervalCap),
        lastStatus: 'already_prompted',
        lastError: null,
        activeCheckinId: null,
      });
      return { ok: true, reason: 'already_prompted' };
    }

    // 5) Within radius → send the check-in prompt.
    if (Number.isFinite(distanceMiles) && distanceMiles <= radius) {
      const checkin = await monitorsDb.createCheckin({
        monitorId: job.id,
        groupId: job.group_id,
        telegramGroupId: job.telegram_group_id,
        orderId: load.orderId,
        stopType,
        locationAddress: targetAddress,
        appointmentAt: appointmentIso || null,
        etaAt: etaAtIso,
        distanceMilesAtPrompt: distanceMiles,
      });

      // Lost the race to a concurrent claim (unique-violation on the stop
      // signature) → another worker is sending this prompt; don't duplicate it.
      if (!checkin || checkin.duplicate) {
        await monitorsDb.releaseMonitor(job.id, {
          ...baseState,
          nextRunAt: minutesFromNowIso(intervalCap),
          lastStatus: 'already_prompted',
          lastError: null,
          activeCheckinId: null,
        });
        return { ok: true, reason: 'already_prompted' };
      }

      // Prefer the Telegram identity selected in Driver Groups (username
      // and/or numeric id — the id alone yields a tg://user?id inline mention
      // for username-less drivers); fall back to a name lookup of captured ids.
      const username = normalizeText(job.telegram_username);
      const driverTag = username || job.telegram_user_id != null
        ? buildMention(
            { username, telegram_user_id: job.telegram_user_id },
            { fallbackName: buildDriverDisplayName(job) }
          )
        : await mentionResolver.mentionForName(buildDriverDisplayName(job), {
            fallbackName: buildDriverDisplayName(job),
          });
      const language = normalizeText(job.group_language) || 'en';
      const text = await buildCheckinMessage({
        driverTag,
        stopType,
        locationLabel: targetCoords?.displayName || targetAddress,
        distanceMiles,
        language,
      });

      let sent = null;
      try {
        sent = await telegramClient.sendMessage(job.telegram_group_id, text, {
          parse_mode: 'HTML',
          reply_markup: buildKeyboard(checkin.id),
        });
      } catch (err) {
        // Retry without HTML if entity parsing fails.
        if (/can't parse entities/i.test(String(err?.message || ''))) {
          sent = await telegramClient.sendMessage(job.telegram_group_id, text.replace(/<\/?[^>]+>/g, ''), {
            reply_markup: buildKeyboard(checkin.id),
          });
        } else {
          throw err;
        }
      }
      await monitorsDb.setCheckinPromptMessageId(checkin.id, sent?.message_id || null);

      await monitorsDb.releaseMonitor(job.id, {
        ...baseState,
        nextRunAt: minutesFromNowIso(NO_ANSWER_REPROMPT_MIN),
        lastStatus: 'checkin_sent',
        lastError: null,
        activeCheckinId: checkin.id,
      });
      console.log(
        `[LOCATION-MONITOR] Check-in prompt sent for group ${job.group_id} `
        + `(${stopType}, ${distanceMiles.toFixed(1)} mi out)`
      );
      return { ok: true, reason: 'checkin_sent', distanceMiles };
    }

    // 6) Still approaching → schedule the next adaptive wake-up.
    const delayMin = nextCheckMinutes({ etaMinutes, intervalCap });
    await monitorsDb.releaseMonitor(job.id, {
      ...baseState,
      nextRunAt: minutesFromNowIso(delayMin),
      lastStatus: 'tracking',
      lastError: null,
      activeCheckinId: null,
    });
    console.log(
      `[LOCATION-MONITOR] group ${job.group_id} heading to ${stopType}; `
      + `${Number.isFinite(distanceMiles) ? distanceMiles.toFixed(1) : '?'}mi, `
      + `ETA ${etaMinutes != null ? Math.round(etaMinutes) : '?'}min, next check ~${delayMin}min`
    );
    return { ok: true, reason: 'tracking', distanceMiles };
  } catch (err) {
    console.error(`[LOCATION-MONITOR] processMonitorJob failed for monitor ${job.id}:`, err.message);
    await monitorsDb.releaseMonitor(job.id, {
      nextRunAt: minutesFromNowIso(RETRY_GAP_MIN),
      lastStatus: 'error',
      lastError: err.message,
      activeCheckinId: job.active_checkin_id || null,
    }).catch(() => {});
    return { ok: false, reason: 'error', error: err.message };
  }
}

/** Immediate evaluation when a group is toggled on (or admin "check now"). */
async function triggerMonitorNowByGroupId(groupId) {
  const claim = await monitorsDb.claimMonitorByGroupId(groupId);
  if (!claim) {
    return { triggered: false, reason: 'not_enabled_or_already_processing' };
  }
  const result = await processMonitorJob(claim);
  return { triggered: true, ...result };
}

async function tickDriverLocationMonitors() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await monitorsDb.expireStaleCheckins(12).catch(() => {});
    if (!telegramClient) return;

    const due = await monitorsDb.claimDueMonitors(MAX_BATCH);
    if (!due.length) return;

    console.log(`[LOCATION-MONITOR] Processing ${due.length} due monitor(s)`);
    for (const job of due) {
      if (schedulerStopped) break;
      await processMonitorJob(job);
    }
  } catch (err) {
    console.error('[LOCATION-MONITOR] Tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function scheduleNextTick() {
  if (schedulerStopped) return;
  schedulerTimer = setTimeout(async () => {
    await tickDriverLocationMonitors();
    scheduleNextTick();
  }, POLL_INTERVAL_MS);
  schedulerTimer.unref?.();
}

function startDriverLocationMonitorService(telegram) {
  if (telegram) configureDriverLocationTelegram(telegram);
  if (config.driverLocationMonitorEnabled === false) {
    console.log('[LOCATION-MONITOR] Disabled by config; not starting.');
    return;
  }
  schedulerStopped = false;
  console.log(`[LOCATION-MONITOR] Service started; polling every ${POLL_INTERVAL_MS / 1000}s`);
  (async () => {
    await tickDriverLocationMonitors();
    scheduleNextTick();
  })();
}

function stopDriverLocationMonitorService() {
  schedulerStopped = true;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  console.log('[LOCATION-MONITOR] Service stopped.');
}

module.exports = {
  configureDriverLocationTelegram,
  extractStopsFromOrder,
  resolveLoad,
  heuristicPhase,
  decideTargetPhase,
  phaseToStopType,
  nextCheckMinutes,
  buildCheckinMessage,
  buildKeyboard,
  processMonitorJob,
  triggerMonitorNowByGroupId,
  tickDriverLocationMonitors,
  startDriverLocationMonitorService,
  stopDriverLocationMonitorService,
  APPOINTMENT_GRACE_MIN,
};
