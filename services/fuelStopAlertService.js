/**
 * Fuel Monitor — gas-station proximity reminders (service façade + scheduler).
 *
 * When the Fuel Monitoring team posts a gas-station location into a driver's
 * Telegram group, a "watching" row is recorded (`fuel_stop_alerts`). This
 * poller watches that driver's live truck GPS and, the moment the truck comes
 * within `radius_miles` of the station, replies to the original message tagging
 * the driver.
 *
 * The behaviour lives in focused modules; this file owns only the service
 * LIFECYCLE — the due-scan tick that index.js starts and stops — and re-exports
 * the public surface so existing importers are unchanged:
 *
 *   ./fuelStop/constants.js      every tuning number, in one readable place
 *   ./fuelStop/textRules.js      PURE filters + poll-gap arithmetic (no I/O)
 *   ./fuelStop/detection.js      the AI fallback, reached only when rules fail
 *   ./fuelStop/capture.js        post -> geocoded watch row (inbox-deduped)
 *   ./fuelStop/reminders.js      near-detection and the reply to the driver
 *   ./fuelStop/driverTag.js      mentioning a username-less driver correctly
 *   ./fuelStop/telegramClient.js the send client, single documented owner
 *
 * Detection stays cheap-first on purpose: most messages are filtered out by the
 * pure rules with no AI call at all.
 */
const db = require('../database/db');
const { ALERT_MAX_BATCH, POLL_INTERVAL_MS } = require('./fuelStop/constants');
const { configureFuelStopTelegram, getFuelStopTelegram } = require('./fuelStop/telegramClient');
const { buildDriverTag } = require('./fuelStop/driverTag');
const {
  messageHasFuelHeader, messageText, extractStationFromText, isCompanyDriverProfile,
  computeNextCheck,
} = require('./fuelStop/textRules');
const { detectStationFromMessage } = require('./fuelStop/detection');
const {
  reactToFuelMessage, handleFuelStopMessage, refreshFuelStopsFromInbox,
} = require('./fuelStop/capture');
const {
  buildReminderBody, buildManualReminderText, sendManualFuelReminder, processFuelAlert,
} = require('./fuelStop/reminders');

let schedulerStopped = false;

let schedulerTimer = null;

let tickRunning = false;

async function tickFuelStopAlerts() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await db.expireOldFuelStopAlerts().catch(() => {});
    await db.deleteOldFuelInbox(3).catch(() => {});
    const telegramClient = getFuelStopTelegram();
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
  buildDriverTag,
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
