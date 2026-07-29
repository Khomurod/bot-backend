/**
 * Home-Time silent-mode transition.
 *
 * What must happen the INSTANT an admin turns "Send clarification messages to
 * driver groups" off — not on the next sweep, and not only for reminders that
 * happen to be due already.
 *
 * The reminder sweep alone is not sufficient. It reads only reminders whose
 * next_reminder_at has already passed, so a reminder scheduled for six hours
 * from now survives the switch and fires the moment messaging is switched back
 * on. That is a message leaking into a driver group after the operator
 * explicitly silenced the bot. This module closes that window with one bulk
 * database UPDATE at the point of change.
 *
 * Nothing here talks to Telegram: staff alerts are ENQUEUED durably and the
 * internal-alert worker delivers them. That guarantees no driver group can be
 * touched during the transition, and that a crash mid-transition loses nothing.
 */
const outbox = require('../database/homeTimeInternalAlertOutbox');
const { isDriverMessagingEnabled } = require('./homeTimeDriverChannel');

/**
 * Is this settings patch switching driver messaging OFF?
 *
 * Only a genuine true → false transition counts. Saving an unrelated setting
 * while already silent, or re-saving `false` over `false`, must not re-run the
 * transition (it would re-enqueue alerts for requests staff were already told
 * about). Pure, so the decision is testable without a database.
 *
 * @param {object|null} current  the settings row BEFORE the update
 * @param {object} patch         the validated column patch about to be applied
 */
function isSilencingTransition(current, patch = {}) {
  if (!Object.prototype.hasOwnProperty.call(patch, 'driver_clarification_enabled')) return false;
  if (patch.driver_clarification_enabled !== false) return false;
  return isDriverMessagingEnabled(current); // was on (or unset, which means on)
}

/**
 * Carry out the transition. Safe to call more than once — every step is a
 * guarded bulk UPDATE — but callers should gate on isSilencingTransition().
 *
 * Order matters: reminders are stood down FIRST, so even if the later steps
 * fail nothing can be sent to a driver.
 *
 * @returns {{ remindersCleared:number, switched:number, enqueued:number }}
 */
async function applySilentModeTransition() {
  const remindersCleared = await outbox.standDownAllDriverReminders();
  const { switched, enqueued } = await outbox.switchOpenClarificationsToInternal();

  console.log('[HOME-TIME-SILENT] Driver messaging switched OFF — '
    + `${remindersCleared} scheduled reminder(s) stood down, `
    + `${switched} open clarification(s) moved to the staff channel, `
    + `${enqueued} staff alert(s) queued. Nothing was sent to any driver group.`);

  return { remindersCleared, switched, enqueued };
}

module.exports = {
  isSilencingTransition,
  applySilentModeTransition,
};
