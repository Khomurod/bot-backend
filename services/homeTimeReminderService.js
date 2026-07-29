/**
 * Home-Time clarification reminder service.
 *
 * When a driver has not supplied a missing home-time date, the bot sends exactly
 * TWO reminders (default 12h apart, both configurable), each replying to the
 * original home-time / Status: Home message and tagging the driver. After the
 * second unanswered reminder the flow is flagged 'clarification_unanswered' for
 * manual follow-up — no further messages are sent.
 *
 * Restart-safe + idempotent (DB-side, mirrors roadBonusNotifierService): each
 * open clarification carries next_reminder_at (when the next reminder is due) and
 * reminder_count (capped at 2). A tick reads due rows, then ATOMICALLY claims each
 * (bump count + move/clear next_reminder_at, guarded on the unchanged count and
 * still-due time) before sending, so overlapping ticks or a restart never double
 * a reminder. No long in-memory timers.
 *
 * A reminder is a DRIVER-GROUP message, so the whole sweep respects the
 * driver-messaging switch (home_time_settings.driver_clarification_enabled). When
 * it is off, due reminders are stood down rather than sent — see the guard in
 * runHomeTimeReminderCheck.
 */
const { DateTime } = require('luxon');
const ht = require('../database/homeTime');
const { callGeminiText } = require('./geminiClient');
const { buildReminderMessage } = require('./homeTimeRequestConstants');
const { buildDriverMention } = require('./driverMention');
const { isDriverMessagingEnabled, sendToDriverGroup } = require('./homeTimeDriverChannel');

const MAX_REMINDERS = 2;
const POLL_MS = 5 * 60 * 1000; // 5 min — reminders are hours apart, so this is ample
const FIRST_TICK_DELAY_MS = 30 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let telegramClient = null;

/** Which single date is this clarification still missing? */
function missingFieldFor(row) {
  if (row.status === 'awaiting_return_to_road') return 'return_to_road';
  if (row.status === 'awaiting_home_start') return 'home_start';
  return 'both';
}

function reminderPrompt(missingField, language) {
  const langLine = language && !['en', 'english'].includes(String(language).toLowerCase())
    ? `Write in the driver's language (${language}); keep it natural and simple.`
    : "Match the driver's language when obvious; otherwise use English.";
  const what = missingField === 'return_to_road'
    ? 'the date they will be back on the road after home time'
    : (missingField === 'home_start'
      ? 'the date they plan to arrive home'
      : 'their home-time dates (arrive home and back on the road)');
  return 'You are a friendly but firm dispatch assistant for a US trucking company. Write ONE short reminder '
    + `(1-2 sentences, plain text, no markdown) asking the driver to clarify ${what}. Say it is important for us `
    + `to know. Do not be aggressive. ${langLine}`;
}

/** AI reminder text with a deterministic fallback (never throws). */
async function buildReminderText(missingField, language) {
  try {
    const { text } = await callGeminiText({ userText: reminderPrompt(missingField, language), maxOutputTokens: 100 });
    const clean = String(text || '').trim();
    if (clean) return clean;
  } catch (err) {
    console.warn('[HOME-TIME-REMINDER] AI reminder text failed, using fallback:', err.message);
  }
  return buildReminderMessage(missingField);
}

/**
 * One reminder sweep. Sends the due reminders, advancing / clearing the schedule
 * atomically and flagging exhausted flows as unanswered. Pure-ish: pass the
 * telegram client so it is unit-testable.
 *
 * @returns {{ enabled:boolean, due:number, sent:number, unanswered:number, errors:number }}
 */
async function runHomeTimeReminderCheck(telegram, { nowIso } = {}) {
  const settings = await ht.getHomeTimeSettings();
  if (!settings || !settings.enabled) {
    return { enabled: false, due: 0, sent: 0, unanswered: 0, errors: 0 };
  }
  const now = nowIso || DateTime.now().toUTC().toISO();
  const secondHours = Math.max(1, Number(settings.reminder_second_hours) || 12);

  const rows = await ht.listDueHomeTimeReminders(now, { maxReminders: MAX_REMINDERS });
  let sent = 0;
  let unanswered = 0;
  let errors = 0;
  let standDown = 0;

  // Driver messaging switched off while reminders were already scheduled. Clear
  // each due row's schedule WITHOUT sending, without consuming one of the two
  // allowed reminders, and without flagging it unanswered: the request stays open
  // in its awaiting_* status for staff to resolve. Clearing (rather than
  // deferring) is what guarantees that switching the setting back on replays
  // nothing and fires no accumulated backlog.
  if (!isDriverMessagingEnabled(settings)) {
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const cleared = await ht.cancelHomeTimeReminderSchedule(row.id).catch(() => null);
      if (cleared) standDown += 1;
    }
    if (standDown) {
      console.log(`[HOME-TIME-REMINDER] Driver messaging disabled — stood down ${standDown} due reminder(s) without sending.`);
    }
    return {
      enabled: true, due: rows.length, sent: 0, unanswered: 0, errors: 0, standDown,
    };
  }

  for (const row of rows) {
    // Skip inactive groups (spec §11: stop when the group becomes inactive).
    if (row.group_active === false) continue;
    const isFinal = Number(row.reminder_count) + 1 >= MAX_REMINDERS;
    const nextReminderAt = isFinal
      ? null
      : DateTime.fromISO(now).plus({ hours: secondHours }).toISO();
    try {
      // eslint-disable-next-line no-await-in-loop
      const claimed = await ht.claimHomeTimeReminder(row.id, {
        expectedReminderCount: Number(row.reminder_count),
        nowIso: now,
        nextReminderAt,
      });
      if (!claimed) continue; // another tick / restart already handled it

      const missingField = missingFieldFor(row);
      const mention = buildDriverMention({
        telegramUserId: row.telegram_user_id,
        username: row.telegram_username,
        displayName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null,
        groupName: row.group_name,
      });
      // eslint-disable-next-line no-await-in-loop
      const body = await buildReminderText(missingField, row.language);
      const text = `${mention.mentionHtml} ${escapeHtml(body)}`;
      const chatId = row.group_telegram_id || row.telegram_group_id;
      const replyTo = row.root_message_id || row.clarification_message_id || null;

      // Routed through the central driver channel rather than calling Telegram
      // directly. The sweep already returns early when messaging is off, so this
      // is defence in depth: the ONE choke point stays the only way a Home-Time
      // message reaches a driver group, and a future edit here cannot bypass it.
      // eslint-disable-next-line no-await-in-loop
      await sendToDriverGroup(telegram, chatId, text, {
        replyToMessageId: replyTo,
        settings,
        reason: 'clarification reminder',
        extra: { parse_mode: 'HTML' },
      });
      sent += 1;

      if (isFinal) {
        // eslint-disable-next-line no-await-in-loop
        await ht.markHomeTimeClarificationUnanswered(row.id).catch(() => {});
        unanswered += 1;
      }
      console.log(`[HOME-TIME-REMINDER] Reminder #${Number(row.reminder_count) + 1}/${MAX_REMINDERS} sent for request #${row.id}.`);
    } catch (err) {
      errors += 1;
      console.error(`[HOME-TIME-REMINDER] Failed reminder for request #${row.id}:`, err.message);
    }
  }
  return {
    enabled: true, due: rows.length, sent, unanswered, errors, standDown,
  };
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Auto-close outdated home-time requests (dates passed / stale clarification) as
 * "Expired — No Action", updating any Telegram card. Runs on the same restart-safe
 * cadence as the reminder sweep and is gated on the feature being enabled. The
 * decision/expiry logic is required lazily so this module can be unit-tested (and
 * the reminder tests loaded) without pulling in config/bot at require time.
 *
 * @returns {{ enabled:boolean, scanned:number, expired:number }}
 */
async function runHomeTimeExpirySweep(telegram, { nowIso } = {}) {
  const settings = await ht.getHomeTimeSettings();
  if (!settings || !settings.enabled) return { enabled: false, scanned: 0, expired: 0 };
  const { sweepOutdatedHomeTimeRequests } = require('./homeTimeApproval');
  const todayIso = (nowIso ? DateTime.fromISO(nowIso) : DateTime.now())
    .setZone('America/Chicago').toISODate();
  const result = await sweepOutdatedHomeTimeRequests(telegram, { todayIso });
  return { enabled: true, ...result };
}

async function tick() {
  if (tickRunning || !telegramClient) return;
  tickRunning = true;
  try {
    await runHomeTimeReminderCheck(telegramClient);
    await runHomeTimeExpirySweep(telegramClient);
    // Rides this service's cadence but is a SEPARATE responsibility: the two
    // sweeps above chase DRIVERS, this one chases STAFF. Required lazily so the
    // reminder tests can load this module without the alert outbox. Isolated in
    // its own try/catch so a staff-alert problem can never stop driver
    // reminders (or vice versa).
    try {
      const { runInternalAlertSweep } = require('./homeTimeInternalAlert');
      await runInternalAlertSweep(telegramClient);
    } catch (alertErr) {
      console.error('[HOME-TIME-INTERNAL] sweep error:', alertErr.message);
    }
  } catch (err) {
    console.error('[HOME-TIME-REMINDER] tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startHomeTimeReminderService(telegram) {
  if (telegram) telegramClient = telegram;
  serviceStopped = false;
  console.log(`[HOME-TIME-REMINDER] Service started — sweeping due clarification reminders every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!serviceStopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, POLL_MS);
  serviceTimer.unref?.();
}

function stopHomeTimeReminderService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  MAX_REMINDERS,
  missingFieldFor,
  buildReminderText,
  runHomeTimeReminderCheck,
  runHomeTimeExpirySweep,
  startHomeTimeReminderService,
  stopHomeTimeReminderService,
  tick,
};
