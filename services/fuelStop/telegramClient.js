/**
 * The Telegram client the Fuel Monitor sends reminders with.
 *
 * SHARED MUTABLE STATE with exactly one owner. index.js hands the bot's
 * telegram instance in at boot via configureFuelStopTelegram(); the reminder
 * path reads it back through getFuelStopTelegram(). It lives in its own module
 * so the sender and the scheduler can both reach it without either importing
 * the other — see CLAUDE.md → Module design ("shared mutable state must have
 * one clearly documented owner").
 */
'use strict';

let telegramClient = null;

/** Called once at boot from index.js. Passing a falsy value disables sending. */
function configureFuelStopTelegram(telegram) {
  telegramClient = telegram || null;
}

/** The configured client, or null before configure (callers must handle null). */
function getFuelStopTelegram() {
  return telegramClient;
}

module.exports = { configureFuelStopTelegram, getFuelStopTelegram };
