/**
 * Inline-button handlers for driver location check-in prompts.
 *
 * When the location monitor detects a truck within the check-in radius of its
 * shipper/receiver, it posts a "report your status" message with
 * Checked In / Checked Out buttons (callback data `loccheck:in:<id>` /
 * `loccheck:out:<id>`). The flow is two-phase:
 *
 *   1. "Checked In" (arrival)  → stamps checked_in_at + who tapped, computes
 *      on-time, and edits the message so ONLY the "Checked Out" button remains.
 *   2. "Checked Out" (departure) → stamps checked_out_at + who tapped and
 *      removes the keyboard. checked_out_at - checked_in_at is the facility
 *      dwell time, collected to later predict how long drivers stay at a
 *      given facility.
 *
 * A driver may also tap "Checked Out" directly (skipping arrival); the visit is
 * then completed without a dwell measurement. Every tap upserts the user into
 * bot_users (username + user id) for the admin panel's Users tab. The stop is
 * never prompted again either way (one-prompt-per-stop guard in the service).
 *
 * Kept free of any require on the monitor *service* to avoid a circular
 * dependency (the service is started from index.js and never imports the bot).
 */
const monitorsDb = require('../database/driverLocationMonitors');
const botUsersDb = require('../database/botUsers');

// Counted on-time if the driver reaches/answers within this grace of the
// appointment (kept in sync with driverLocationMonitorService.APPOINTMENT_GRACE_MIN).
const APPOINTMENT_GRACE_MIN = 15;
const ADVANCE_AFTER_ANSWER_MIN = 3;

function minutesFromNowIso(minutes) {
  return new Date(Date.now() + Math.max(0, Number(minutes) || 0) * 60_000).toISOString();
}

/**
 * On-time = the driver reached/answered at the stop no later than the
 * appointment (plus a short grace). Null when no appointment is known.
 */
function computeOnTime(appointmentAt, nowMs = Date.now()) {
  if (!appointmentAt) return null;
  const apptMs = Date.parse(String(appointmentAt));
  if (!Number.isFinite(apptMs)) return null;
  const grace = APPOINTMENT_GRACE_MIN * 60_000;
  return nowMs <= apptMs + grace;
}

/** After arrival only the departure button remains on the prompt. */
function buildCheckoutOnlyKeyboard(checkinId) {
  return {
    inline_keyboard: [[
      { text: '🚪 Checked Out', callback_data: `loccheck:out:${checkinId}` },
    ]],
  };
}

/** "132" minutes → "2h 12m"; "45" → "45m". */
function formatDwell(minutes) {
  if (minutes == null) return null;
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return null;
  const hours = Math.floor(m / 60);
  const mins = Math.round(m % 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** Best-effort user capture for the admin Users tab; never blocks the answer. */
async function trackButtonUser(from, action, groupId) {
  try {
    await botUsersDb.recordBotUserInteraction({
      telegramUserId: from?.id,
      username: from?.username || null,
      firstName: from?.first_name || null,
      lastName: from?.last_name || null,
      action,
      groupId,
    });
  } catch (err) {
    console.warn('[LOCATION-MONITOR] Could not record bot user interaction:', err.message);
  }
}

function registerLocationCheckinHandlers(bot) {
  bot.action(/^loccheck:(in|out):(\d+)$/, async (ctx) => {
    try {
      const action = ctx.match[1];
      const checkinId = parseInt(ctx.match[2], 10);
      const from = ctx.from || {};

      const checkin = await monitorsDb.getCheckinById(checkinId);
      if (!checkin) {
        await ctx.answerCbQuery('This check-in is no longer available.');
        return;
      }

      // Only accept the answer on the current prompt message in its own group.
      const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;
      const isCurrentPrompt = String(callbackChatId) === String(checkin.telegram_group_id)
        && (checkin.prompt_message_id == null
          || String(callbackMessageId) === String(checkin.prompt_message_id));
      if (!isCurrentPrompt) {
        await ctx.answerCbQuery('This is an old check-in prompt.', { show_alert: true });
        return;
      }

      await trackButtonUser(from, `loccheck:${action}`, checkin.group_id);

      const stopLabel = checkin.stop_type === 'shipper' ? 'shipper' : 'receiver';
      const originalText = ctx.callbackQuery?.message?.text || '';

      if (action === 'in') {
        const onTime = computeOnTime(checkin.appointment_at);
        const { record, alreadyDone } = await monitorsDb.recordCheckinArrival(checkinId, {
          username: from.username || null,
          userId: from.id || null,
          onTime,
        });
        if (!record) {
          await ctx.answerCbQuery('This check-in is no longer available.');
          return;
        }
        if (alreadyDone) {
          const by = record.checked_in_by_username || record.checked_out_by_username;
          await ctx.answerCbQuery(
            record.status === 'checked_in'
              ? `Already checked in${by ? ` by @${by}` : ''} — tap Checked Out when you leave.`
              : 'This check-in is already closed.'
          );
          return;
        }

        const punctuality = onTime === null ? '' : onTime ? ' • on time' : ' • late';
        const footer = `\n\n✅ Checked in at the ${stopLabel}${punctuality}. Tap 🚪 Checked Out when you leave.`;
        try {
          await ctx.editMessageText(`${originalText}${footer}`, {
            reply_markup: buildCheckoutOnlyKeyboard(checkinId),
          });
        } catch (err) {
          // Fall back to only swapping the keyboard if the text edit fails.
          try { await ctx.editMessageReplyMarkup(buildCheckoutOnlyKeyboard(checkinId)); } catch (_) { /* ignore */ }
        }
        await ctx.answerCbQuery('✅ Checked in — thank you!');

        // Arrival confirms the stop: clear the cached target so the monitor
        // advances to the next stop (pickup → delivery). It will never
        // re-prompt this stop (the one-prompt-per-stop guard blocks that).
        try {
          await monitorsDb.clearMonitorTarget(checkin.monitor_id, {
            nextRunAt: minutesFromNowIso(ADVANCE_AFTER_ANSWER_MIN),
            lastStatus: `checked_in_${stopLabel}`,
          });
        } catch (err) {
          console.warn('[LOCATION-MONITOR] Could not advance monitor after check-in:', err.message);
        }

        console.log(
          `[LOCATION-MONITOR] Check-in ${checkinId} arrival recorded `
          + `(${stopLabel}${onTime === null ? '' : onTime ? ', on time' : ', late'}) by `
          + `${from.username ? `@${from.username}` : from.id}`
        );
        return;
      }

      // action === 'out' — departure. Normal path is from 'checked_in'; tapping
      // it straight from the initial prompt also completes the visit (no dwell).
      const skippedArrival = checkin.status === 'awaiting_response';
      const onTime = skippedArrival ? computeOnTime(checkin.appointment_at) : null;
      const { record, alreadyDone } = await monitorsDb.recordCheckinDeparture(checkinId, {
        username: from.username || null,
        userId: from.id || null,
        onTime,
      });
      if (!record) {
        await ctx.answerCbQuery('This check-in is no longer available.');
        return;
      }
      if (alreadyDone) {
        const by = record.checked_out_by_username;
        await ctx.answerCbQuery(`Already checked out${by ? ` by @${by}` : ''}.`);
        return;
      }

      const dwellLabel = formatDwell(record.dwell_minutes);
      const footer = dwellLabel
        ? `\n\n🚪 Checked out of the ${stopLabel} — stayed ${dwellLabel}. Thank you!`
        : `\n\n🚪 Checked out of the ${stopLabel} — thank you!`;
      try {
        await ctx.editMessageText(`${originalText}${footer}`);
      } catch (err) {
        try { await ctx.editMessageReplyMarkup(); } catch (_) { /* ignore */ }
      }
      await ctx.answerCbQuery('🚪 Checked out — thank you!');

      // If the driver never tapped Checked In, the monitor was not advanced at
      // arrival — advance it now so the load moves to its next phase.
      if (skippedArrival) {
        try {
          await monitorsDb.clearMonitorTarget(checkin.monitor_id, {
            nextRunAt: minutesFromNowIso(ADVANCE_AFTER_ANSWER_MIN),
            lastStatus: `checked_out_${stopLabel}`,
          });
        } catch (err) {
          console.warn('[LOCATION-MONITOR] Could not advance monitor after checkout:', err.message);
        }
      }

      console.log(
        `[LOCATION-MONITOR] Check-in ${checkinId} departure recorded `
        + `(${stopLabel}${dwellLabel ? `, dwell ${dwellLabel}` : ''}) by `
        + `${from.username ? `@${from.username}` : from.id}`
      );
    } catch (err) {
      console.error('[LOCATION-MONITOR] Check-in callback error:', err.message);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (_) { /* ignore */ }
    }
  });

  console.log('[LOCATION-MONITOR] Check-in handlers registered.');
}

module.exports = { registerLocationCheckinHandlers, computeOnTime, formatDwell };
