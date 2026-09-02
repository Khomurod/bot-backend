/**
 * CAPTURE side of the Fuel Monitor: turning a posted gas station into a watch.
 *
 * `fuel_monitor_inbox` is the idempotency guard here — one fuel post creates one
 * watch, however many times the message pipeline sees it (APP_BRIEF §7).
 * Geocoding the station is what makes the radius check possible later.
 *
 * Split out of services/fuelStopAlertService.js, which re-exports these.
 */
const db = require('../../database/db');
const { geocodePlace } = require('../etaRoutingService');
const { DEFAULT_RADIUS_MILES, REFRESH_WINDOW_HOURS, REFRESH_MAX_ROWS } = require('./constants');
const {
  normalizeText, messageText, messageHasFuelHeader, isCompanyDriverProfile,
} = require('./textRules');
const { detectStationFromMessage } = require('./detection');
// One-way edge: capture drives the alert path, never the reverse.
const { processFuelAlert } = require('./reminders');

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
  const rows = await db.listPendingFuelInbox(REFRESH_WINDOW_HOURS, REFRESH_MAX_ROWS).catch(() => []);
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

module.exports = {
  reactToFuelMessage,
  handleFuelStopMessage,
  refreshFuelStopsFromInbox,
};
